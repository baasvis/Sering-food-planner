try { require('dotenv').config(); } catch (_e) {}
const request = require('supertest');
const app = require('../app').default;
const { prisma } = require('../lib/db');

// Test IDs — prefixed to avoid collision with real data
const T = 'test-' + Date.now() + '-';

afterAll(async () => {
  await prisma.recipeIngredientRow.deleteMany({ where: { recipeId: { startsWith: T } } });
  await prisma.recipePhoto.deleteMany({ where: { recipeId: { startsWith: T } } });
  await prisma.recipe.deleteMany({ where: { id: { startsWith: T } } });
  await prisma.batch.deleteMany({ where: { id: { startsWith: T } } });
  await prisma.recipeIndex.deleteMany({ where: { id: { startsWith: T } } });
  await prisma.ingredient.deleteMany({ where: { id: { startsWith: T } } });
  await prisma.standardInventory.deleteMany({ where: { id: { startsWith: T } } });
  await prisma.feedback.deleteMany({ where: { user: 'test-runner' } });
  await prisma.guestHistory.deleteMany({ where: { date: { startsWith: '2099-' } } });
  await prisma.guestsNextWeeks.deleteMany({ where: { mondayKey: { startsWith: '2099-' } } });
  await prisma.$disconnect();
});

// ── Health ──

describe('GET /api/health', () => {
  it('returns status ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.dbConnected).toBe(true);
  });
});

// ── Auth (dev mode) ──

describe('Auth (dev mode)', () => {
  let cookie: string[];

  it('POST /api/auth/google — dev login', async () => {
    const res = await request(app)
      .post('/api/auth/google')
      .send({ idToken: 'dev' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user.email).toBe('dev@local');
    cookie = res.headers['set-cookie'] as unknown as string[];
  });

  it('GET /api/auth/me — returns user', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('dev@local');
  });

  it('POST /api/auth/logout — clears session', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /api/auth/me — 401 after logout', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookie);
    expect(res.status).toBe(401);
  });
});

// ── Data ──

describe('GET /api/data', () => {
  it('returns planner state', async () => {
    const res = await request(app).get('/api/data');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('batches');
    expect(res.body).toHaveProperty('guests');
    expect(res.body).toHaveProperty('caterings');
    expect(res.body).toHaveProperty('recipeIndex');
    expect(res.body).toHaveProperty('transportItems');
    expect(Array.isArray(res.body.batches)).toBe(true);
  });
});

describe('POST /api/data', () => {
  // Legacy endpoint was the destructive delete-all/create-all path. Now returns
  // 410 Gone — clients must use POST /api/data/patch instead.
  it('returns 410 Gone (legacy endpoint removed)', async () => {
    const res = await request(app)
      .post('/api/data')
      .send({ batches: [] });
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/legacy/i);
    expect(res.body.message).toMatch(/\/api\/data\/patch/);
  });
});

// ── Batch CRUD ──

describe('Batch CRUD API', () => {
  const batchId = T + 'batch-1';

  it('POST /api/batches — creates a batch', async () => {
    const res = await request(app)
      .post('/api/batches')
      .send({
        id: batchId,
        name: 'Test Tomatensoep',
        type: 'Soup',
        stock: 0,
        serving: 280,
        storage: 'Gastro',
        location: 'west',
        services: [{ loc: 'west', date: '2026-04-01', meal: 'lunch' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(batchId);
    expect(res.body.name).toBe('Test Tomatensoep');
    expect(res.body.location).toBe('west');
    expect(res.body.services).toHaveLength(1);
  });

  it('POST /api/batches — rejects duplicate id', async () => {
    const res = await request(app)
      .post('/api/batches')
      .send({
        id: batchId,
        name: 'Duplicate',
        type: 'Soup',
        stock: 0,
        serving: 280,
        storage: 'Gastro',
        location: 'west',
        services: [],
      });
    expect(res.status).toBe(409);
  });

  it('POST /api/batches — rejects invalid location', async () => {
    const res = await request(app)
      .post('/api/batches')
      .send({
        id: T + 'bad-loc',
        name: 'Bad Location',
        type: 'Soup',
        stock: 0,
        serving: 280,
        storage: 'Gastro',
        location: 'invalid',
        services: [],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid location/i);
  });

  it('GET /api/batches — lists batches', async () => {
    const res = await request(app).get('/api/batches');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const found = res.body.find((b: any) => b.id === batchId);
    expect(found).toBeTruthy();
  });

  it('GET /api/batches/:id — returns single batch', async () => {
    const res = await request(app).get('/api/batches/' + batchId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(batchId);
    expect(res.body.name).toBe('Test Tomatensoep');
  });

  it('GET /api/batches/:id — 404 for unknown id', async () => {
    const res = await request(app).get('/api/batches/nonexistent');
    expect(res.status).toBe(404);
  });

  it('PATCH /api/batches/:id — partial update', async () => {
    const res = await request(app)
      .patch('/api/batches/' + batchId)
      .send({ stock: 5.0, note: 'Extra thick today' });
    expect(res.status).toBe(200);
    expect(res.body.stock).toBe(5.0);
    expect(res.body.note).toBe('Extra thick today');
    expect(res.body.name).toBe('Test Tomatensoep');
  });

  it('PATCH /api/batches/:id — 404 for unknown id', async () => {
    const res = await request(app)
      .patch('/api/batches/nonexistent')
      .send({ stock: 1 });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/batches/:id — rejects when stock > 0', async () => {
    const res = await request(app).delete('/api/batches/' + batchId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/stock > 0/);
  });

  it('DELETE /api/batches/:id — succeeds when stock = 0', async () => {
    await request(app)
      .patch('/api/batches/' + batchId)
      .send({ stock: 0 });

    const res = await request(app).delete('/api/batches/' + batchId);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const check = await request(app).get('/api/batches/' + batchId);
    expect(check.status).toBe(404);
  });

  it('DELETE /api/batches/:id — 404 for unknown id', async () => {
    const res = await request(app).delete('/api/batches/nonexistent');
    expect(res.status).toBe(404);
  });
});

// ── Ingredients ──

describe('Ingredients API', () => {
  const ingId = T + 'ing-1';

  it('GET /api/ingredients — returns list', async () => {
    const res = await request(app).get('/api/ingredients');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/ingredients/full — returns full list', async () => {
    const res = await request(app).get('/api/ingredients/full');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/ingredients/:id — creates ingredient', async () => {
    const res = await request(app)
      .post('/api/ingredients/' + ingId)
      .send({ id: ingId, name: 'Test Potato', category: 'Vegetables', unit: 'Grams', active: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /api/ingredients/:id — updates ingredient', async () => {
    const res = await request(app)
      .post('/api/ingredients/' + ingId)
      .send({ id: ingId, name: 'Test Potato Updated', category: 'Vegetables', unit: 'Grams', active: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const check = await request(app).get('/api/ingredients/full');
    const found = check.body.find((i: any) => i.id === ingId);
    expect(found).toBeTruthy();
    expect(found.name).toBe('Test Potato Updated');
  });

  it('DELETE /api/ingredients/:id — deletes ingredient', async () => {
    const res = await request(app).delete('/api/ingredients/' + ingId);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── Ingredient Stock ──

describe('POST /api/ingredients/stock', () => {
  const stockIngId = T + 'stock-ing';

  beforeAll(async () => {
    await request(app)
      .post('/api/ingredients/' + stockIngId)
      .send({ id: stockIngId, name: 'Stock Test', unit: 'Grams', active: true });
  });

  afterAll(async () => {
    await prisma.ingredient.deleteMany({ where: { id: stockIngId } });
  });

  it('updates stock for an ingredient', async () => {
    const res = await request(app)
      .post('/api/ingredients/stock')
      .send({ ingredientId: stockIngId, location: 'west', amount: 500 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── Recipes ──

describe('Recipe Index API', () => {
  const recipeId = T + 'recipe-1';

  it('GET /api/recipe-index — returns list', async () => {
    const res = await request(app).get('/api/recipe-index');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/recipe-index — creates recipe', async () => {
    const res = await request(app)
      .post('/api/recipe-index')
      .send({ id: recipeId, name: 'Test Soup', type: 'Soup', createdAt: new Date().toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /api/recipe-index — rejects without id', async () => {
    const res = await request(app)
      .post('/api/recipe-index')
      .send({ name: 'No ID' });
    expect(res.status).toBe(400);
  });

  it('DELETE /api/recipe-index/:id — deletes recipe', async () => {
    const res = await request(app).delete('/api/recipe-index/' + recipeId);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── Standard Inventory ──

describe('Standard Inventory API', () => {
  const siId = T + 'si-1';

  it('GET /api/standard-inventory — returns items', async () => {
    const res = await request(app).get('/api/standard-inventory?location=west');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/standard-inventory — saves items', async () => {
    const res = await request(app)
      .post('/api/standard-inventory')
      .send({ location: 'west', items: [{ id: siId, name: 'Test Flour', amount: 1000, unit: 'Grams' }] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /api/standard-inventory — rejects missing location', async () => {
    const res = await request(app)
      .post('/api/standard-inventory')
      .send({ items: [] });
    expect(res.status).toBe(400);
  });
});

// ── Feedback ──

describe('Feedback API', () => {
  it('POST /api/feedback — saves feedback', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .send({ text: 'Test feedback', type: 'bug', user: 'test-runner' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /api/feedback — rejects empty text', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .send({ type: 'bug' });
    expect(res.status).toBe(400);
  });
});

// ── Storage Config ──

describe('Storage Config API', () => {
  it('GET /api/storage-config — returns config', async () => {
    const res = await request(app).get('/api/storage-config');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
  });
});

// ── Prep Checklist ──

describe('Prep Checklist API', () => {
  it('GET /api/prep-checklist — requires loc and date', async () => {
    const res = await request(app).get('/api/prep-checklist');
    expect(res.status).toBe(400);
  });

  it('POST + GET /api/prep-checklist — roundtrip', async () => {
    const loc = 'west';
    const date = '2099-01-01';
    const checked = ['item-a', 'item-b'];

    const postRes = await request(app)
      .post('/api/prep-checklist')
      .send({ loc, date, checked });
    expect(postRes.status).toBe(200);

    const getRes = await request(app).get(`/api/prep-checklist?loc=${loc}&date=${date}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual(checked);

    await prisma.prepChecklist.deleteMany({ where: { loc, date } });
  });
});

// ── Activity Log ──

describe('GET /api/log', () => {
  it('returns log entries', async () => {
    const res = await request(app).get('/api/log');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── Guest History ──

describe('Guest History API', () => {
  it('GET /api/guest-history — returns data', async () => {
    const res = await request(app).get('/api/guest-history');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
  });
});

// ── Guests Next Weeks ──

describe('Guests Next Weeks API', () => {
  it('GET /api/guests-next-weeks — returns data', async () => {
    const res = await request(app).get('/api/guests-next-weeks');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
  });
});

// ── Ingredient Target Stock ──

describe('Ingredient Target Stock API', () => {
  const ingId = T + 'target-stock-ing';

  beforeAll(async () => {
    await request(app)
      .post('/api/ingredients/' + ingId)
      .send({ id: ingId, name: 'Target Stock Test', unit: 'Grams', active: true });
  });

  afterAll(async () => {
    await prisma.ingredient.deleteMany({ where: { id: ingId } });
  });

  it('POST /api/ingredients/target-stock — sets target stock', async () => {
    const res = await request(app)
      .post('/api/ingredients/target-stock')
      .send({ ingredientId: ingId, location: 'west', amount: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify via /full
    const full = await request(app).get('/api/ingredients/full');
    const found = full.body.find((i: any) => i.id === ingId);
    expect(found).toBeTruthy();
    expect(found.targetStock.west).toBe(1000);
  });

  it('POST /api/ingredients/target-stock — clears target with amount 0', async () => {
    const res = await request(app)
      .post('/api/ingredients/target-stock')
      .send({ ingredientId: ingId, location: 'west', amount: 0 });
    expect(res.status).toBe(200);

    const full = await request(app).get('/api/ingredients/full');
    const found = full.body.find((i: any) => i.id === ingId);
    expect(found.targetStock.west).toBeUndefined();
  });

  it('POST /api/ingredients/target-stock — 400 without ingredientId', async () => {
    const res = await request(app)
      .post('/api/ingredients/target-stock')
      .send({ location: 'west', amount: 500 });
    expect(res.status).toBe(400);
  });

  it('POST /api/ingredients/target-stock — 404 for unknown ingredient', async () => {
    const res = await request(app)
      .post('/api/ingredients/target-stock')
      .send({ ingredientId: 'nonexistent-ing', location: 'west', amount: 500 });
    expect(res.status).toBe(404);
  });
});

// ── Ingredient Stock Bulk ──

describe('Ingredient Stock Bulk API', () => {
  const ing1 = T + 'bulk-ing-1';
  const ing2 = T + 'bulk-ing-2';

  beforeAll(async () => {
    await request(app)
      .post('/api/ingredients/' + ing1)
      .send({ id: ing1, name: 'Bulk Test 1', unit: 'Grams', active: true });
    await request(app)
      .post('/api/ingredients/' + ing2)
      .send({ id: ing2, name: 'Bulk Test 2', unit: 'Liters', active: true });
  });

  afterAll(async () => {
    await prisma.ingredient.deleteMany({ where: { id: { in: [ing1, ing2] } } });
  });

  it('POST /api/ingredients/stock/bulk — updates multiple ingredients', async () => {
    const res = await request(app)
      .post('/api/ingredients/stock/bulk')
      .send([
        { ingredientId: ing1, location: 'west', amount: 500 },
        { ingredientId: ing2, location: 'centraal', amount: 2.5 },
      ]);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.updated).toBe(2);

    // Verify stock was set
    const full = await request(app).get('/api/ingredients/full');
    const found1 = full.body.find((i: any) => i.id === ing1);
    const found2 = full.body.find((i: any) => i.id === ing2);
    expect(found1.stock.west.amount).toBe(500);
    expect(found2.stock.centraal.amount).toBe(2.5);
  });

  it('POST /api/ingredients/stock/bulk — 400 for non-array', async () => {
    const res = await request(app)
      .post('/api/ingredients/stock/bulk')
      .send({ ingredientId: ing1, location: 'west', amount: 100 });
    expect(res.status).toBe(400);
  });

  // Regression: two simultaneous /stock writes for different locations on the
  // same ingredient must both apply. Without withWriteLock, the read-modify-
  // write on the JSON `stock` column raced and one of the two values was
  // silently dropped. (Audit §3.1 lost-update bug.)
  it('POST /api/ingredients/stock — concurrent writes both apply', async () => {
    // Reset to a known empty state
    await prisma.ingredient.update({
      where: { id: ing1 },
      data: { stock: {} as any },
    });

    // Fire two concurrent stock writes for the same ingredient at different locations
    const [r1, r2] = await Promise.all([
      request(app)
        .post('/api/ingredients/stock')
        .send({ ingredientId: ing1, location: 'west', amount: 111 }),
      request(app)
        .post('/api/ingredients/stock')
        .send({ ingredientId: ing1, location: 'centraal', amount: 222 }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // Both writes must be present
    const after = await prisma.ingredient.findUnique({ where: { id: ing1 } });
    const stock = (after?.stock || {}) as Record<string, { amount: number; date: string }>;
    expect(stock.west?.amount).toBe(111);
    expect(stock.centraal?.amount).toBe(222);
  });
});

// ── Guest History Roundtrip ──

describe('Guest History Roundtrip', () => {
  it('POST /api/guest-history and GET roundtrip', async () => {
    const testData = {
      west: { lunch: { '2099-01-01': 42, '2099-01-02': 38 } },
    };

    const postRes = await request(app)
      .post('/api/guest-history')
      .send(testData);
    expect(postRes.status).toBe(200);
    expect(postRes.body.ok).toBe(true);

    const getRes = await request(app).get('/api/guest-history');
    expect(getRes.status).toBe(200);
    expect(getRes.body.west).toBeTruthy();
    expect(getRes.body.west.lunch['2099-01-01']).toBe(42);
    expect(getRes.body.west.lunch['2099-01-02']).toBe(38);
  });

  it('POST /api/guest-history — 400 for null body', async () => {
    const res = await request(app)
      .post('/api/guest-history')
      .set('Content-Type', 'application/json')
      .send('null');
    expect(res.status).toBe(400);
  });
});

// ── Guests Next Weeks Roundtrip ──

describe('Guests Next Weeks Roundtrip', () => {
  it('POST /api/guests-next-weeks and GET roundtrip', async () => {
    const testData = {
      '2099-01-06': {
        west: {
          monday: { lunch: 30, dinner: 25 },
        },
      },
    };

    const postRes = await request(app)
      .post('/api/guests-next-weeks')
      .send(testData);
    expect(postRes.status).toBe(200);
    expect(postRes.body.ok).toBe(true);

    const getRes = await request(app).get('/api/guests-next-weeks');
    expect(getRes.status).toBe(200);
    expect(getRes.body['2099-01-06']).toBeTruthy();
    expect(getRes.body['2099-01-06'].west.monday.lunch).toBe(30);
    expect(getRes.body['2099-01-06'].west.monday.dinner).toBe(25);
  });

  it('POST /api/guests-next-weeks — 400 for null body', async () => {
    const res = await request(app)
      .post('/api/guests-next-weeks')
      .set('Content-Type', 'application/json')
      .send('null');
    expect(res.status).toBe(400);
  });
});

// ── Feedback CRUD ──

describe('Feedback CRUD', () => {
  let feedbackId: number;

  it('GET /api/feedback — returns array', async () => {
    const res = await request(app).get('/api/feedback');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST + GET + PATCH — create, find, mark processed', async () => {
    // Create
    const postRes = await request(app)
      .post('/api/feedback')
      .send({ text: 'CRUD test feedback', type: 'idea', user: 'test-runner' });
    expect(postRes.status).toBe(200);

    // Find it in the list
    const listRes = await request(app).get('/api/feedback');
    const found = listRes.body.find((f: any) => f.text === 'CRUD test feedback');
    expect(found).toBeTruthy();
    expect(found.processed).toBe(false);
    feedbackId = found.id;

    // Mark processed
    const patchRes = await request(app)
      .patch('/api/feedback/' + feedbackId)
      .send({ processed: true });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.processed).toBe(true);

    // Verify it stayed processed
    const verifyRes = await request(app).get('/api/feedback');
    const updated = verifyRes.body.find((f: any) => f.id === feedbackId);
    expect(updated.processed).toBe(true);
  });

  it('PATCH /api/feedback/:id — 400 for non-boolean processed', async () => {
    const res = await request(app)
      .patch('/api/feedback/' + feedbackId)
      .send({ processed: 'yes' });
    expect(res.status).toBe(400);
  });

  it('PATCH /api/feedback/:id — 400 for invalid id', async () => {
    const res = await request(app)
      .patch('/api/feedback/notanumber')
      .send({ processed: true });
    expect(res.status).toBe(400);
  });
});

// ── Finance Revenue ──

describe('Finance Revenue API', () => {
  it('GET /api/finance/revenue — returns array with valid params', async () => {
    const res = await request(app).get('/api/finance/revenue?start=2020-01-01&end=2020-01-02');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/finance/revenue — 400 without params', async () => {
    const res = await request(app).get('/api/finance/revenue');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/start and end/i);
  });
});

// ── Finance Products ──

describe('Finance Products API', () => {
  it('GET /api/finance/products — returns array with valid params', async () => {
    const res = await request(app).get('/api/finance/products?start=2020-01-01&end=2020-01-02');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/finance/products — groupBy=category returns array', async () => {
    const res = await request(app).get('/api/finance/products?start=2020-01-01&end=2020-01-02&groupBy=category');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/finance/products — 400 without params', async () => {
    const res = await request(app).get('/api/finance/products');
    expect(res.status).toBe(400);
  });
});

// ── Finance Sync Status ──
//
// The sync helper used to expose only in-memory state. After 31 days of
// silent breakage (only 8 DailyRevenue rows in prod, all from 2026-03-26),
// /sync-status now hydrates from telemetry events so a recent failure is
// visible after server restart and surfaces in AI insights.
describe('Finance Sync Status', () => {
  it('GET /api/finance/sync-status — returns expected shape', async () => {
    const res = await request(app).get('/api/finance/sync-status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('syncing');
    expect(res.body).toHaveProperty('lastSyncAt');
    expect(res.body).toHaveProperty('lastSyncError');
    expect(res.body).toHaveProperty('lastSyncErrorDetails');
    expect(res.body).toHaveProperty('tebiConfigured');
    expect(typeof res.body.syncing).toBe('boolean');
  });

  it('POST /api/finance/sync — refuses when TEBI credentials are missing', async () => {
    // Tests run without TEBI_EMAIL/TEBI_PASSWORD set, so the helper must
    // refuse with a 500 + clear error message rather than spawning a worker
    // that would crash on auth.
    const prevEmail = process.env.TEBI_EMAIL;
    const prevPass = process.env.TEBI_PASSWORD;
    delete process.env.TEBI_EMAIL;
    delete process.env.TEBI_PASSWORD;
    try {
      const res = await request(app).post('/api/finance/sync').send({ startDate: '2020-01-01', endDate: '2020-01-01' });
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/TEBI_EMAIL/);
    } finally {
      if (prevEmail !== undefined) process.env.TEBI_EMAIL = prevEmail;
      if (prevPass !== undefined) process.env.TEBI_PASSWORD = prevPass;
    }
  });
});

// ── Data Patch ──

describe('Data Patch API', () => {
  const patchBatchId = T + 'patch-batch';

  it('POST /api/data/patch — adds a batch, then deletes it', async () => {
    // Add a batch via patch
    const addRes = await request(app)
      .post('/api/data/patch')
      .send({
        batches: [{
          id: patchBatchId,
          name: 'Patch Test Soup',
          type: 'Soup',
          stock: 0,
          serving: 280,
          storage: 'Gastro',
          location: 'west',
          services: [],
        }],
      });
    expect(addRes.status).toBe(200);
    expect(addRes.body.ok).toBe(true);

    // Verify it appears in GET /api/data
    const dataRes = await request(app).get('/api/data');
    const found = dataRes.body.batches.find((b: any) => b.id === patchBatchId);
    expect(found).toBeTruthy();
    expect(found.name).toBe('Patch Test Soup');

    // Delete it via patch
    const delRes = await request(app)
      .post('/api/data/patch')
      .send({ deletedBatches: [patchBatchId] });
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);

    // Verify it's gone
    const checkRes = await request(app).get('/api/data');
    const gone = checkRes.body.batches.find((b: any) => b.id === patchBatchId);
    expect(gone).toBeUndefined();
  }, 15000);
});

// ── Recipe v2 CRUD ──

describe('Recipe v2 CRUD', () => {
  const recipeId = T + 'recipe-1';
  const ingId = T + 'recipe-ing-1';

  // Create a test ingredient for linking
  beforeAll(async () => {
    await prisma.ingredient.create({
      data: {
        id: T + 'ing-lentils',
        name: 'Red lentils (test)',
        category: 'Legumes & Proteins',
        unit: 'Grams',
        pricePer100g: 0.301,
        allergens: '',
        active: true,
      },
    });
    await prisma.ingredient.create({
      data: {
        id: T + 'ing-onion',
        name: 'Onion (test)',
        category: 'Vegetables & Fruit',
        unit: 'Grams',
        pricePer100g: 0.0675,
        allergens: 'Onion',
        active: true,
        nutrition: { energyKcal: 40, energyKj: 166, fat: 0.1, saturatedFat: 0, carbs: 9.3, sugar: 4.2, fiber: 1.7, protein: 1.1, salt: 0 },
      },
    });
  });

  it('POST /api/recipes — create recipe with ingredients', async () => {
    const res = await request(app)
      .post('/api/recipes')
      .send({
        id: recipeId,
        name: 'Test Lentil Soup',
        type: 'Soup',
        servingSize: 280,
        recipeVolume: 8.5,
        structure: 'Open structure',
        seasonality: 'Year round',
        prepSteps: [{ step: 1, text: 'Heat oil' }, { step: 2, text: 'Add lentils' }],
        coolingMethod: 'Blast chiller',
        storageMethod: 'Label and refrigerate',
        ingredients: [
          { id: ingId, ingredientId: T + 'ing-lentils', sortOrder: 0, rawAmount: 500, unit: 'Grams', isFlexible: false, suggestedNames: [] },
          { id: T + 'recipe-ing-2', ingredientId: T + 'ing-onion', sortOrder: 1, rawAmount: 1000, unit: 'Grams', isFlexible: false, suggestedNames: [] },
          { id: T + 'recipe-ing-3', ingredientId: null, sortOrder: 2, rawAmount: 3000, unit: 'Grams', isFlexible: true, flexCategory: 'Vegetables & Fruit', flexLabel: 'Any vegetables', suggestedNames: ['Carrot', 'Pumpkin'] },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Test Lentil Soup');
    expect(res.body.ingredients).toHaveLength(3);
    expect(res.body.autoAllergens).toContain('Onion');
    expect(res.body.costPerServing).toBeGreaterThan(0);
    expect(res.body.prepSteps).toHaveLength(2);
    expect(res.body.ingredients[2].isFlexible).toBe(true);
    expect(res.body.ingredients[2].flexLabel).toBe('Any vegetables');
  });

  it('GET /api/recipes — lists recipes', async () => {
    const res = await request(app).get('/api/recipes');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const found = res.body.find((r: any) => r.id === recipeId);
    expect(found).toBeTruthy();
    expect(found.ingredients).toHaveLength(3);
  });

  it('GET /api/recipes/:id — single recipe with nutrition', async () => {
    const res = await request(app).get(`/api/recipes/${recipeId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(recipeId);
    expect(res.body.ingredients[0].ingredientName).toBe('Red lentils (test)');
    expect(res.body.nutrition).toBeTruthy();
    expect(res.body.nutrition.completeness).toBeGreaterThan(0);
  });

  it('PATCH /api/recipes/:id — update metadata', async () => {
    const res = await request(app)
      .patch(`/api/recipes/${recipeId}`)
      .send({ name: 'Updated Lentil Soup', seasonality: 'Winter' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Lentil Soup');
    expect(res.body.seasonality).toBe('Winter');
  });

  it('PATCH /api/recipes/:id — update ingredients', async () => {
    const res = await request(app)
      .patch(`/api/recipes/${recipeId}`)
      .send({
        ingredients: [
          { id: T + 'recipe-ing-new', ingredientId: T + 'ing-lentils', sortOrder: 0, rawAmount: 800, unit: 'Grams', isFlexible: false, suggestedNames: [] },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.ingredients).toHaveLength(1);
    expect(res.body.ingredients[0].rawAmount).toBe(800);
  });

  it('POST /api/recipes/:id/version — save version snapshot', async () => {
    const res = await request(app)
      .post(`/api/recipes/${recipeId}/version`)
      .send({ notes: 'Reduced to just lentils' });
    expect(res.status).toBe(200);
    expect(res.body.versions).toHaveLength(1);
    expect(res.body.versions[0].version).toBe(1);
    expect(res.body.versions[0].notes).toBe('Reduced to just lentils');
  });

  it('GET /api/recipes/:id/versions — version history', async () => {
    const res = await request(app).get(`/api/recipes/${recipeId}/versions`);
    expect(res.status).toBe(200);
    expect(res.body.versions).toHaveLength(1);
  });

  it('GET /api/recipes/nonexistent — 404', async () => {
    const res = await request(app).get('/api/recipes/nonexistent');
    expect(res.status).toBe(404);
  });

  it('POST /api/recipes — generates id when frontend omits it (regression: triage-2026-04-26 B1)', async () => {
    // The frontend recipe editor does not send an `id` in the create payload.
    // Recipe.id has no @default in the Prisma schema, so the server must
    // generate one — otherwise Prisma rejects the create and the recipe is
    // silently lost (production incident 2026-04-20: "pupkin veggie stew").
    const res = await request(app)
      .post('/api/recipes')
      .send({
        name: 'Triage No-Id Recipe ' + T,
        type: 'Soup',
        servingSize: 280,
        recipeVolume: 5,
        ingredients: [
          { ingredientId: null, sortOrder: 0, rawAmount: 100, unit: 'Grams', isFlexible: true, flexCategory: 'Vegetables & Fruit', flexLabel: 'Any vegetables', suggestedNames: [] },
        ],
      });
    expect(res.status).toBe(200);
    expect(typeof res.body.id).toBe('string');
    expect(res.body.id.length).toBeGreaterThan(0);
    expect(res.body.ingredients).toHaveLength(1);
    expect(typeof res.body.ingredients[0].id).toBe('string');
    expect(res.body.ingredients[0].id.length).toBeGreaterThan(0);
    // Clean up — this row was created without a T-prefixed id, so it would
    // not be cleaned by the suite's afterAll.
    const { PrismaClient } = require('@prisma/client');
    const p = new PrismaClient();
    try {
      await p.recipeIngredientRow.deleteMany({ where: { recipeId: res.body.id } });
      await p.recipe.delete({ where: { id: res.body.id } });
    } finally {
      await p.$disconnect();
    }
  });

  it('POST /api/recipes — 400 for invalid data', async () => {
    const res = await request(app).post('/api/recipes').send({ id: T + 'bad', name: '' });
    expect(res.status).toBe(400);
  });

  it('GET /api/ingredients/suggest — suggests by category', async () => {
    const res = await request(app).get('/api/ingredients/suggest?category=Vegetables%20%26%20Fruit&location=west');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/recipes/recalculate-costs — recalculates all', async () => {
    const res = await request(app).post('/api/recipes/recalculate-costs');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.total).toBe('number');
  }, 30000);

  it('GET /api/data — includes recipes array', async () => {
    const res = await request(app).get('/api/data');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.recipes)).toBe(true);
  });

  it('GET /api/recipes/:id/print — returns printable HTML', async () => {
    const res = await request(app).get(`/api/recipes/${recipeId}/print`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('De Sering');
    expect(res.text).toContain('Updated Lentil Soup');
    expect(res.text).toContain('Ingredients');
    expect(res.text).toContain('@media print');
  });

  it('GET /api/recipes/:id/print — 404 for nonexistent', async () => {
    const res = await request(app).get('/api/recipes/nonexistent/print');
    expect(res.status).toBe(404);
  });

  it('DELETE /api/recipes/:id — deletes recipe', async () => {
    const res = await request(app).delete(`/api/recipes/${recipeId}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const check = await request(app).get(`/api/recipes/${recipeId}`);
    expect(check.status).toBe(404);
  });
});
