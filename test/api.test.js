try { require('dotenv').config(); } catch (e) {}
const request = require('supertest');
const app = require('../app');
const { prisma } = require('../lib/db');

// Test IDs — prefixed to avoid collision with real data
const T = 'test-' + Date.now() + '-';

afterAll(async () => {
  // Clean up test data
  await prisma.recipeIndex.deleteMany({ where: { id: { startsWith: T } } });
  await prisma.ingredient.deleteMany({ where: { id: { startsWith: T } } });
  await prisma.standardInventory.deleteMany({ where: { id: { startsWith: T } } });
  await prisma.feedback.deleteMany({ where: { user: 'test-runner' } });
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
  let cookie;

  it('POST /api/auth/google — dev login', async () => {
    const res = await request(app)
      .post('/api/auth/google')
      .send({ idToken: 'dev' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user.email).toBe('dev@local');
    cookie = res.headers['set-cookie'];
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
    expect(res.body).toHaveProperty('dishes');
    expect(res.body).toHaveProperty('guests');
    expect(res.body).toHaveProperty('caterings');
    expect(res.body).toHaveProperty('recipeIndex');
    expect(res.body).toHaveProperty('transportItems');
    expect(Array.isArray(res.body.dishes)).toBe(true);
  });
});

describe('POST /api/data', () => {
  it('rejects invalid dishes', async () => {
    const res = await request(app)
      .post('/api/data')
      .send({ dishes: [{ id: 'x', name: 'Bad', type: 'INVALID' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid type/i);
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

    // Verify update
    const check = await request(app).get('/api/ingredients/full');
    const found = check.body.find(i => i.id === ingId);
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
    const date = '2099-01-01'; // far future to avoid collision
    const checked = ['item-a', 'item-b'];

    const postRes = await request(app)
      .post('/api/prep-checklist')
      .send({ loc, date, checked });
    expect(postRes.status).toBe(200);

    const getRes = await request(app).get(`/api/prep-checklist?loc=${loc}&date=${date}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual(checked);

    // Clean up
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
