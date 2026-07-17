/**
 * POST /api/ingredients/target-stock/copy — bulk-copy standard-inventory
 * targets from one location to another ("preload this event with Sering
 * West's standard order"). Single server-side jsonb merge; skip-existing
 * unless overwrite. Exercised through the real route handler + staging DB.
 */

process.env.DIRECTOR_EMAILS = process.env.DIRECTOR_EMAILS || 'dev@local';

try { require('dotenv').config(); } catch (_e) {}
const request = require('supertest');
const app = require('../app').default;
const { prisma, dbLoadEventLocations } = require('../lib/db');
const { Prisma } = require('@prisma/client');

const T = 'test-tscopy-' + Date.now();
const EV = 'ev-tscopy-' + Date.now();

jest.setTimeout(30_000);

async function loginDirector(): Promise<string[]> {
  const res = await request(app).post('/api/auth/google').send({ idToken: 'dev' });
  expect(res.status).toBe(200);
  return res.headers['set-cookie'] as unknown as string[];
}

/** A test ingredient with a West standard target already set. */
async function seedIngredient(id: string, westTarget: number, extra: Record<string, unknown> = {}): Promise<void> {
  await prisma.ingredient.create({
    data: {
      id, name: `${T} ${id}`, category: 'Test', types: [],
      targetStock: { west: westTarget, ...extra } as object,
      stock: {} as object,
    },
  });
}

beforeAll(async () => {
  await prisma.eventLocation.create({
    data: { id: EV, name: `Zzz TScopy ${Date.now()}`, startDate: '2026-07-20', endDate: '2026-07-30', createdBy: 'dev@local' },
  });
  await dbLoadEventLocations();
});

afterAll(async () => {
  await prisma.ingredient.deleteMany({ where: { id: { startsWith: T } } });
  // The copy is GLOBAL (every ingredient with a West target), so it wrote the
  // EV key onto the ~90 real staging ingredients too — strip it from all rows.
  await prisma.$executeRaw`UPDATE ingredients SET target_stock = target_stock - ${EV} WHERE target_stock ? ${EV}`;
  await prisma.eventLocation.deleteMany({ where: { id: EV } });
  await dbLoadEventLocations();
  await prisma.$disconnect();
});

describe('POST /api/ingredients/target-stock/copy', () => {
  it('copies West standard targets onto an event location, skipping items already set and zero/absent sources', async () => {
    const cookie = await loginDirector();
    const a = `${T}-a`, b = `${T}-b`, c = `${T}-c`, d = `${T}-d`;
    await seedIngredient(a, 5);                                    // copied
    await seedIngredient(b, 12);                                   // copied
    await seedIngredient(c, 0);                                    // west=0 → skipped
    await seedIngredient(d, 8, { [EV]: 99 });                     // already set at EV → kept (skip-existing)

    const res = await request(app).post('/api/ingredients/target-stock/copy').set('Cookie', cookie)
      .send({ fromLocation: 'west', toLocation: EV });
    expect(res.status).toBe(200);
    // The copy is GLOBAL (all ingredients with a West target), so assert on the
    // specific seeded rows, not the total count (staging has other West items).
    expect(res.body.copied).toBeGreaterThanOrEqual(2);

    const byId = async () => Object.fromEntries(
      (await prisma.ingredient.findMany({ where: { id: { in: [a, b, c, d] } } }))
        .map((r: { id: string; targetStock: Record<string, number> }) => [r.id, r.targetStock]),
    );
    let m = await byId();
    expect(m[a][EV]).toBe(5);
    expect(m[b][EV]).toBe(12);
    expect(m[c][EV]).toBeUndefined();  // west was 0 — nothing to copy
    expect(m[d][EV]).toBe(99);         // hand-set value preserved

    // Re-run is a no-op for already-set rows (skip-existing).
    const again = await request(app).post('/api/ingredients/target-stock/copy').set('Cookie', cookie)
      .send({ fromLocation: 'west', toLocation: EV });
    expect(again.body.copied).toBe(0);

    // overwrite=true replaces the hand-set value on d.
    const forced = await request(app).post('/api/ingredients/target-stock/copy').set('Cookie', cookie)
      .send({ fromLocation: 'west', toLocation: EV, overwrite: true });
    expect(forced.body.copied).toBeGreaterThanOrEqual(3); // at least a, b, d
    m = await byId();
    expect(m[d][EV]).toBe(8);           // west value now overwrites the hand-set 99
  });

  it('rejects bad input and archived/unknown destinations', async () => {
    const cookie = await loginDirector();
    expect((await request(app).post('/api/ingredients/target-stock/copy').set('Cookie', cookie)
      .send({ fromLocation: 'west' })).status).toBe(400);
    expect((await request(app).post('/api/ingredients/target-stock/copy').set('Cookie', cookie)
      .send({ fromLocation: 'west', toLocation: 'west' })).status).toBe(400);
    expect((await request(app).post('/api/ingredients/target-stock/copy').set('Cookie', cookie)
      .send({ fromLocation: 'west', toLocation: 'ev-does-not-exist' })).status).toBe(400);

    // Archived destination is rejected (ACTIVE-only seed target).
    await request(app).post(`/api/event-locations/${EV}/archive`).set('Cookie', cookie);
    await dbLoadEventLocations();
    expect((await request(app).post('/api/ingredients/target-stock/copy').set('Cookie', cookie)
      .send({ fromLocation: 'west', toLocation: EV })).status).toBe(400);
    await request(app).post(`/api/event-locations/${EV}/unarchive`).set('Cookie', cookie);
    await dbLoadEventLocations();
  });
});
