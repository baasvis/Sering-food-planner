try { require('dotenv').config(); } catch (_e) {}
const request = require('supertest');
const app = require('../app').default;
const { prisma } = require('../lib/db');

const T = 'test-sup-' + Date.now() + '-';

afterAll(async () => {
  await prisma.supply.deleteMany({ where: { id: { startsWith: T } } });
  await prisma.catering.deleteMany({ where: { id: { startsWith: T } } });
  await prisma.$disconnect();
});

// ──────────────────────────────────────────────────────────────────────────
// SUPPLIES — toppings, breads, ferments, pickles. Standard supplies have a
// per-guest ratio + horizon; one-offs drip-feed unitsPerService until
// depleted. Tests cover CRUD + prep-event + delete-with-stock guard +
// catering toppings round-trip.
// ──────────────────────────────────────────────────────────────────────────
describe('Supplies', () => {
  let cookie: string[];
  beforeAll(async () => {
    const login = await request(app).post('/api/auth/google').send({ idToken: 'dev' });
    cookie = login.headers['set-cookie'] as unknown as string[];
  });

  it('POST /api/supplies — creates a standard supply', async () => {
    const res = await request(app).post('/api/supplies').set('Cookie', cookie).send({
      id: T + 'aioli',
      name: 'Aioli',
      kind: 'standard',
      unit: 'boxes',
      guestsPerUnit: 20,
      prepHorizonDays: 4,
      prepMode: 'centralized',
      costPerUnit: 6.4,
      preservationMethod: 'Sugar preservation',
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(T + 'aioli');
    expect(res.body.kind).toBe('standard');
    expect(res.body.archived).toBe(false);
    expect(res.body.stock.west.amount).toBe(0);
    expect(res.body.stock.centraal.amount).toBe(0);
    expect(res.body.costPerUnit).toBe(6.4);
    expect(res.body.preservationMethod).toBe('Sugar preservation');
  });

  it('POST /api/supplies — rejects a negative costPerUnit', async () => {
    const res = await request(app).post('/api/supplies').set('Cookie', cookie).send({
      id: T + 'badcost', name: 'X', kind: 'standard', unit: 'boxes',
      guestsPerUnit: 10, prepHorizonDays: 1, prepMode: 'centralized', costPerUnit: -3,
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/supplies — creates a one-off supply', async () => {
    const res = await request(app).post('/api/supplies').set('Cookie', cookie).send({
      id: T + 'chimi',
      name: 'Chimichurri',
      kind: 'oneoff',
      unit: 'jars',
      oneoffLocation: 'west',
      unitsPerService: 2,
      oneoffStartDate: '2026-05-11',
    });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('oneoff');
    expect(res.body.unitsPerService).toBe(2);
    expect(res.body.guestsPerUnit).toBeNull();
  });

  it('POST /api/supplies — rejects invalid kind', async () => {
    const res = await request(app).post('/api/supplies').set('Cookie', cookie).send({
      id: T + 'bad', name: 'X', kind: 'whatever', unit: 'g',
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/supplies — rejects standard without guestsPerUnit', async () => {
    const res = await request(app).post('/api/supplies').set('Cookie', cookie).send({
      id: T + 'bad2', name: 'X', kind: 'standard', unit: 'boxes',
      prepHorizonDays: 1, prepMode: 'centralized',
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/supplies — rejects oneoff without unitsPerService', async () => {
    const res = await request(app).post('/api/supplies').set('Cookie', cookie).send({
      id: T + 'bad3', name: 'X', kind: 'oneoff', unit: 'g',
      oneoffLocation: 'west', oneoffStartDate: '2026-05-11',
    });
    expect(res.status).toBe(400);
  });

  it('GET /api/supplies — lists non-archived by default', async () => {
    const res = await request(app).get('/api/supplies').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const ids = res.body.map((s: any) => s.id);
    expect(ids).toContain(T + 'aioli');
    expect(ids).toContain(T + 'chimi');
  });

  it('PATCH /api/supplies/:id — updates fields', async () => {
    const res = await request(app).patch('/api/supplies/' + T + 'aioli').set('Cookie', cookie).send({
      name: 'Aioli (garlic-heavy)',
      kind: 'standard',
      unit: 'boxes',
      guestsPerUnit: 15,
      prepHorizonDays: 5,
      prepMode: 'centralized',
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Aioli (garlic-heavy)');
    expect(res.body.guestsPerUnit).toBe(15);
    expect(res.body.prepHorizonDays).toBe(5);
  });

  it('POST /api/supplies/:id/prep — adds to stock and stamps lastMakeDate', async () => {
    const res = await request(app).post('/api/supplies/' + T + 'aioli/prep').set('Cookie', cookie)
      .send({ location: 'west', amount: 800 });
    expect(res.status).toBe(200);
    expect(res.body.stock.west.amount).toBe(800);
    expect(res.body.stock.west.lastMakeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('POST /api/supplies/:id/prep — accumulates across calls', async () => {
    const res = await request(app).post('/api/supplies/' + T + 'aioli/prep').set('Cookie', cookie)
      .send({ location: 'west', amount: 200 });
    expect(res.status).toBe(200);
    expect(res.body.stock.west.amount).toBe(1000);
  });

  it('POST /api/supplies/:id/prep — rejects invalid location', async () => {
    const res = await request(app).post('/api/supplies/' + T + 'aioli/prep').set('Cookie', cookie)
      .send({ location: 'mars', amount: 100 });
    expect(res.status).toBe(400);
  });

  it('POST /api/supplies/:id/stock — sets absolute amount', async () => {
    const res = await request(app).post('/api/supplies/' + T + 'aioli/stock').set('Cookie', cookie)
      .send({ location: 'west', amount: 500 });
    expect(res.status).toBe(200);
    expect(res.body.stock.west.amount).toBe(500);
    expect(res.body.archived).toBe(false);
  });

  it('DELETE /api/supplies/:id — refuses when stock > 0', async () => {
    const res = await request(app).delete('/api/supplies/' + T + 'aioli').set('Cookie', cookie);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/stock/i);
  });

  it('DELETE /api/supplies/:id — succeeds after zeroing stock', async () => {
    await request(app).post('/api/supplies/' + T + 'aioli/stock').set('Cookie', cookie)
      .send({ location: 'west', amount: 0 });
    const res = await request(app).delete('/api/supplies/' + T + 'aioli').set('Cookie', cookie);
    expect(res.status).toBe(200);
  });

  it('one-off auto-archives when stock hits 0 via /stock', async () => {
    await request(app).post('/api/supplies/' + T + 'chimi/prep').set('Cookie', cookie)
      .send({ location: 'west', amount: 6 });
    let res = await request(app).get('/api/supplies').set('Cookie', cookie);
    let chimi = res.body.find((s: any) => s.id === T + 'chimi');
    expect(chimi.archived).toBe(false);
    await request(app).post('/api/supplies/' + T + 'chimi/stock').set('Cookie', cookie)
      .send({ location: 'west', amount: 0 });
    res = await request(app).get('/api/supplies').set('Cookie', cookie);
    chimi = res.body.find((s: any) => s.id === T + 'chimi');
    expect(chimi).toBeUndefined();
    res = await request(app).get('/api/supplies?includeArchived=1').set('Cookie', cookie);
    chimi = res.body.find((s: any) => s.id === T + 'chimi');
    expect(chimi.archived).toBe(true);
  });

  it('GET /api/data — includes supplies in bootstrap response', async () => {
    const res = await request(app).get('/api/data').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.supplies)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// CATERING toppings — round-trip catering.toppings via /api/data/patch.
// ──────────────────────────────────────────────────────────────────────────
describe('Catering toppings', () => {
  let cookie: string[];
  beforeAll(async () => {
    const login = await request(app).post('/api/auth/google').send({ idToken: 'dev' });
    cookie = login.headers['set-cookie'] as unknown as string[];
    // A real supply for catering toppings to reference.
    await request(app).post('/api/supplies').set('Cookie', cookie).send({
      id: T + 'cat-aioli', name: 'Catering Aioli', kind: 'standard', unit: 'g',
      guestsPerUnit: 30, prepHorizonDays: 4, prepMode: 'centralized',
    });
  });

  it('POST /api/data/patch — accepts catering with toppings referencing a real supply', async () => {
    const res = await request(app).post('/api/data/patch').set('Cookie', cookie).send({
      caterings: [{
        id: T + 'cat-1',
        name: 'Test wedding',
        date: '15/05/2026',
        guestCount: 80,
        deliveryMode: 'delivery',
        dishes: [],
        toppings: [{ supplyId: T + 'cat-aioli', amount: 500 }],
        logisticsNotes: '',
        createdAt: new Date().toISOString(),
      }],
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const data = await request(app).get('/api/data').set('Cookie', cookie);
    const cat = data.body.caterings.find((c: any) => c.id === T + 'cat-1');
    expect(cat).toBeDefined();
    expect(cat.toppings).toEqual([{ supplyId: T + 'cat-aioli', amount: 500 }]);
  });

  it('POST /api/data/patch — rejects invalid topping shape', async () => {
    const res = await request(app).post('/api/data/patch').set('Cookie', cookie).send({
      caterings: [{
        id: T + 'cat-2',
        name: 'Bad catering',
        date: '15/05/2026',
        guestCount: 80,
        deliveryMode: 'delivery',
        dishes: [],
        toppings: [{ supplyId: 123, amount: 'lots' }],
        logisticsNotes: '',
        createdAt: new Date().toISOString(),
      }],
    });
    expect(res.status).toBe(400);
  });
});
