try { require('dotenv').config(); } catch (_e) {}
const request = require('supertest');
const app = require('../app').default;
const { prisma } = require('../lib/db');
const { CONFIG } = require('../lib/config');

// Test IDs — prefixed to avoid collision with real data
const T = 'test-' + Date.now() + '-';

afterAll(async () => {
  await prisma.recipeIngredientRow.deleteMany({ where: { recipeId: { startsWith: T } } });
  await prisma.recipePhoto.deleteMany({ where: { recipeId: { startsWith: T } } });
  await prisma.recipe.deleteMany({ where: { id: { startsWith: T } } });
  await prisma.batch.deleteMany({ where: { id: { startsWith: T } } });
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
    expect(res.body).toHaveProperty('recipes');
    expect(res.body).toHaveProperty('transportItems');
    expect(Array.isArray(res.body.batches)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// S6 — bearer compare uses crypto.timingSafeEqual; behaviour must still
// reject mismatched / missing / wrong-length tokens with 401 (and 503 when
// the env var is unset).
// ──────────────────────────────────────────────────────────────────────────
describe('S6 — coverage bearer compare', () => {
  let originalKey: string | undefined;

  beforeAll(() => { originalKey = process.env.COVERAGE_API_KEY; });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.COVERAGE_API_KEY;
    else process.env.COVERAGE_API_KEY = originalKey;
  });

  it('returns 503 when COVERAGE_API_KEY is unset', async () => {
    delete process.env.COVERAGE_API_KEY;
    const res = await request(app).get('/api/coverage/snapshot').set('Authorization', 'Bearer anything');
    expect(res.status).toBe(503);
  });

  it('returns 401 for a wrong bearer (same length as expected)', async () => {
    process.env.COVERAGE_API_KEY = 'correct-key-1234';
    const res = await request(app).get('/api/coverage/snapshot').set('Authorization', 'Bearer wrong-key-12345');
    expect(res.status).toBe(401);
  });

  it('returns 401 for a wrong bearer (different length)', async () => {
    // crypto.timingSafeEqual throws on mismatched lengths; the length-guard
    // before it must catch this without crashing.
    process.env.COVERAGE_API_KEY = 'correct-key-1234';
    const res = await request(app).get('/api/coverage/snapshot').set('Authorization', 'Bearer x');
    expect(res.status).toBe(401);
  });

  it('returns 401 for missing Authorization header', async () => {
    process.env.COVERAGE_API_KEY = 'correct-key-1234';
    const res = await request(app).get('/api/coverage/snapshot');
    expect(res.status).toBe(401);
  });

  it('returns 200 for the correct bearer', async () => {
    process.env.COVERAGE_API_KEY = 'correct-key-1234';
    const res = await request(app).get('/api/coverage/snapshot').set('Authorization', 'Bearer correct-key-1234');
    expect(res.status).toBe(200);
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

// ──────────────────────────────────────────────────────────────────────────
// T19a — bulk POST /api/ingredients must NOT wipe recipe→ingredient FKs.
// Previously the route did `deleteMany + createMany` which fired the SET
// NULL trigger on `recipe_ingredients.ingredient_id` for every row. Fix
// uses INSERT … ON CONFLICT DO UPDATE so existing rows are touched in-
// place — UPDATE doesn't fire the trigger.
// ──────────────────────────────────────────────────────────────────────────
describe('T19a — bulk ingredient save preserves recipe FK pointers', () => {
  const t19aIngId = T + 't19a-ing';
  const t19aRecipeId = T + 't19a-recipe';
  const t19aRowId = T + 't19a-ri';

  beforeAll(async () => {
    // Seed a real ingredient + a recipe linking to it (FK non-NULL).
    await prisma.ingredient.create({
      data: {
        id: t19aIngId,
        name: 'T19a Test Ingredient',
        category: 'Vegetables & Fruit',
        unit: 'Grams',
        active: true,
      },
    });
    await prisma.recipe.create({
      data: {
        id: t19aRecipeId,
        name: 'T19a Recipe',
        type: 'Soup',
        servingSize: 280,
        recipeVolume: 1.0,
        autoAllergens: [],
        extraAllergens: [],
        prepSteps: [],
        coolingMethod: '',
        storageMethod: '',
        isComplete: true,
        versions: [],
        createdBy: 'test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ingredients: {
          create: [{
            id: t19aRowId,
            ingredientId: t19aIngId,
            sortOrder: 0,
            rawAmount: 100,
            unit: 'Grams',
            isFlexible: false,
            suggestedNames: [],
          }],
        },
      },
    });
    // Sanity check: FK is non-NULL before we start.
    const before = await prisma.recipeIngredientRow.findUnique({ where: { id: t19aRowId } });
    expect(before?.ingredientId).toBe(t19aIngId);
  });

  afterAll(async () => {
    await prisma.recipeIngredientRow.deleteMany({ where: { recipeId: t19aRecipeId } });
    await prisma.recipe.deleteMany({ where: { id: t19aRecipeId } });
    await prisma.ingredient.deleteMany({ where: { id: t19aIngId } });
  });

  // Bulk endpoint touches the entire ingredient table (~1.1k rows on
  // staging) — way over Jest's 5s default.
  it('POST /api/ingredients — recipe FKs survive a full bulk save', async () => {
    // Send the complete current ingredient set, unchanged. Same shape
    // applySupplierUpdate sends from the frontend.
    const all = await prisma.ingredient.findMany();
    const payload = all.map(i => ({
      ...i,
      stock: i.stock || {},
    }));

    const res = await request(app).post('/api/ingredients').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // The critical assertion: the FK pointer on the recipe-ingredient row
    // is STILL pointing at our test ingredient. If the deleteMany shape
    // ever creeps back, the SET NULL trigger would null this and the
    // assertion fails immediately.
    const after = await prisma.recipeIngredientRow.findUnique({ where: { id: t19aRowId } });
    expect(after?.ingredientId).toBe(t19aIngId);
  }, 60_000);

  it('POST /api/ingredients — broader: zero new NULLs across the whole table', async () => {
    // Stronger check: count NULL FKs before and after — the count should
    // be unchanged. Catches the wipe even if the test ingredient survives
    // for some other reason. Note: on staging where every recipe-
    // ingredient row was already wiped (T19a's pre-fix damage, 618/618
    // NULL), this assertion is trivial — the first test is the load-
    // bearing one. On a clean test DB or on prod (where 604/625 rows are
    // still linked at the time of this fix), it actually exercises the
    // full surface.
    const nullsBefore = await prisma.recipeIngredientRow.count({ where: { ingredientId: null } });
    const all = await prisma.ingredient.findMany();
    const payload = all.map(i => ({ ...i, stock: i.stock || {} }));
    await request(app).post('/api/ingredients').send(payload);
    const nullsAfter = await prisma.recipeIngredientRow.count({ where: { ingredientId: null } });
    // Allow nullsAfter <= nullsBefore (other test runs in parallel can
     // create + delete recipe-ingredient rows, briefly changing the count).
     // The bug we're guarding against is the bulk POST INCREASING the NULL
     // count, so any decrease or equal is fine.
    expect(nullsAfter).toBeLessThanOrEqual(nullsBefore);
  }, 60_000);
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
// Legacy /api/recipe-index endpoints removed in S12 — see routes/recipes.ts.
// Recipe v2 has its own test suite below ('Recipe v2 CRUD').

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

  // S9 validation surface — every patch field is now validated before any DB
  // write. Previously deletedBatches/Caterings/TransportItems and the
  // caterings/transportItems arrays themselves were forwarded straight to
  // Prisma. Audit §6.1.

  it('POST /api/data/patch — rejects deletedBatches that is not an array', async () => {
    const res = await request(app)
      .post('/api/data/patch')
      .send({ deletedBatches: 'not-an-array' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deletedBatches/i);
  });

  it('POST /api/data/patch — rejects deletedBatches with > 500 ids', async () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    const res = await request(app)
      .post('/api/data/patch')
      .send({ deletedBatches: tooMany });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too many/i);
  });

  it('POST /api/data/patch — rejects deletedBatches with non-string entries', async () => {
    const res = await request(app)
      .post('/api/data/patch')
      .send({ deletedBatches: ['valid', 1234] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deletedBatches\[1\]/i);
  });

  it('POST /api/data/patch — rejects malformed catering', async () => {
    const res = await request(app)
      .post('/api/data/patch')
      .send({
        caterings: [{
          id: T + 'c1', name: 'x', date: 'not-a-date', guestCount: 0,
          deliveryMode: 'pickup', dishes: [], logisticsNotes: '',
        }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/date/i);
  });

  it('POST /api/data/patch — rejects malformed transport item', async () => {
    const res = await request(app)
      .post('/api/data/patch')
      .send({ transportItems: [{ id: T + 't1', text: 123 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/text/i);
  });
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
        pricePer100: 0.301,
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
        pricePer100: 0.0675,
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

  // ── S8: photo upload mimetype hardening ──
  // 1x1 transparent PNG (smallest valid PNG, 67 bytes)
  const PNG_BYTES = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6300010000000500010d0a2db40000000049454e44ae426082',
    'hex',
  );
  // SVG with an inline script — the kind of payload S8 is meant to block.
  const SVG_XSS = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

  it('POST /api/recipes/:id/photo — accepts whitelisted mimetype (png)', async () => {
    const res = await request(app)
      .post(`/api/recipes/${recipeId}/photo`)
      .attach('photo', PNG_BYTES, { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /api/recipes/:id/photo — sets nosniff and inline disposition with controlled filename', async () => {
    const res = await request(app).get(`/api/recipes/${recipeId}/photo`);
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe(`inline; filename="recipe-${recipeId}.png"`);
    // Express appends `; charset=utf-8` automatically; the major/minor type
     // is what matters (and what nosniff anchors to).
    expect(res.headers['content-type']).toMatch(/^image\/png/);
  });

  it('POST /api/recipes/:id/photo — rejects image/svg+xml (XSS payload)', async () => {
    const res = await request(app)
      .post(`/api/recipes/${recipeId}/photo`)
      .attach('photo', SVG_XSS, { filename: 'bad.svg', contentType: 'image/svg+xml' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/jpg|png|webp|gif/i);
  });

  it('POST /api/recipes/:id/photo — rejects non-image mimetypes', async () => {
    const res = await request(app)
      .post(`/api/recipes/${recipeId}/photo`)
      .attach('photo', Buffer.from('plain text'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
  });

  it('POST /api/recipes/:id/photo — case-insensitive mimetype match', async () => {
    const res = await request(app)
      .post(`/api/recipes/${recipeId}/photo`)
      .attach('photo', PNG_BYTES, { filename: 'a.PNG', contentType: 'IMAGE/PNG' });
    expect(res.status).toBe(200);
  });

  it('DELETE /api/recipes/:id — deletes recipe', async () => {
    const res = await request(app).delete(`/api/recipes/${recipeId}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const check = await request(app).get(`/api/recipes/${recipeId}`);
    expect(check.status).toBe(404);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// S3/S4 — AUTH_MODE='production' disables the dev-mode bypass + fails closed
// on empty ALLOWED_EMAILS. The boot guard in server.ts is a separate
// process-level exit; runtime tests cover the request-time defenses.
// ──────────────────────────────────────────────────────────────────────────

describe('S3/S4 — AUTH_MODE=production runtime gates', () => {
  let originalAuthMode: string;
  let originalAllowed: string[];

  beforeAll(() => {
    originalAuthMode = CONFIG.AUTH_MODE;
    originalAllowed = CONFIG.ALLOWED_EMAILS;
    CONFIG.AUTH_MODE = 'production';
  });

  afterAll(() => {
    CONFIG.AUTH_MODE = originalAuthMode;
    CONFIG.ALLOWED_EMAILS = originalAllowed;
  });

  it('POST /api/auth/google — dev-mode bypass is OFF when AUTH_MODE=production', async () => {
    // GOOGLE_CLIENT_ID is empty in the test env. Without AUTH_MODE='production'
    // the dev-login shortcut would issue a session here. With it on, the
    // request must fall through to the real Google verify path and 401.
    const res = await request(app)
      .post('/api/auth/google')
      .send({ idToken: 'dev' });
    expect(res.status).toBe(401);
  });

  it('GET /api/data — auth middleware no longer falls through when AUTH_MODE=production', async () => {
    // Same shape as above: without GOOGLE_CLIENT_ID, the middleware would
    // next() in dev mode. With AUTH_MODE='production', it must require auth.
    const res = await request(app).get('/api/data');
    expect(res.status).toBe(401);
  });

  // The empty-ALLOWED_EMAILS path returns 503 only AFTER verifyGoogleToken
  // succeeds — and forging a real Google ID token in a unit test is more
  // hassle than the test is worth. The primary defense for S4 is the
  // boot-time guard in server.ts (which exits before app.listen if
  // AUTH_MODE=production && ALLOWED_EMAILS is empty), and the 503 path is
  // a belt-and-suspenders runtime fallback. Verified by direct read.
});

// ──────────────────────────────────────────────────────────────────────────
// S2 — stored XSS via the `id` field. Validators reject any id that doesn't
// match /^[a-zA-Z0-9_-]{1,200}$/ so a payload-shaped id (`'); alert(1); //`)
// can't be planted at the API boundary and reflected unescaped from the
// onclick="" interpolations in caterings.ts / dishes.ts / planner.ts.
// ──────────────────────────────────────────────────────────────────────────

describe('S2 — id charset validation rejects XSS-shaped ids', () => {
  const XSS_ID = "');alert(1);('";
  const baseBatch = {
    name: 'XSS Test', type: 'Soup', stock: 0, serving: 280,
    storage: 'Gastro', location: 'west', services: [],
  };

  it('POST /api/batches — rejects id with quote/paren', async () => {
    const res = await request(app).post('/api/batches').send({ ...baseBatch, id: XSS_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
  });

  it('POST /api/batches — rejects id with HTML angle brackets', async () => {
    const res = await request(app).post('/api/batches').send({ ...baseBatch, id: T + '<script>' });
    expect(res.status).toBe(400);
  });

  it('POST /api/batches — accepts a UUID-shaped id (control)', async () => {
    const id = T + 's2-control-' + Math.random().toString(36).slice(2, 8);
    const res = await request(app).post('/api/batches').send({ ...baseBatch, id });
    expect(res.status).toBe(201);
    await prisma.batch.deleteMany({ where: { id } });
  });

  it('POST /api/data/patch — rejects malicious id inside batches[]', async () => {
    const res = await request(app).post('/api/data/patch').send({
      batches: [{ ...baseBatch, id: XSS_ID }],
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/data/patch — rejects malicious id inside deletedBatches[]', async () => {
    const res = await request(app).post('/api/data/patch').send({
      deletedBatches: [XSS_ID],
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/data/patch — rejects malicious dish.dishId inside caterings', async () => {
    const res = await request(app).post('/api/data/patch').send({
      caterings: [{
        id: T + 's2-cat',
        name: 'Catering',
        date: null,
        guestCount: 0,
        deliveryMode: 'pickup',
        dishes: [{ dishId: XSS_ID, name: 'X', type: 'Soup' }],
        logisticsNotes: '',
      }],
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/recipes — rejects malicious body.id', async () => {
    const res = await request(app).post('/api/recipes').send({
      id: XSS_ID,
      name: 'XSS Recipe',
      type: 'Soup',
      servingSize: 280,
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/recipes — rejects malicious ingredient.ingredientId', async () => {
    const res = await request(app).post('/api/recipes').send({
      name: 'XSS Recipe Ing',
      type: 'Soup',
      servingSize: 280,
      ingredients: [{
        id: T + 's2-ri',
        ingredientId: XSS_ID,
        sortOrder: 0,
        rawAmount: 100,
        unit: 'Grams',
        isFlexible: false,
        suggestedNames: [],
      }],
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/recipes — rejects malicious recipe-ingredient row id', async () => {
    const res = await request(app).post('/api/recipes').send({
      name: 'XSS Recipe Row Id',
      type: 'Soup',
      servingSize: 280,
      ingredients: [{
        id: XSS_ID,
        sortOrder: 0,
        rawAmount: 100,
        unit: 'Grams',
        isFlexible: false,
        suggestedNames: [],
      }],
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/ingredients/:id — rejects malicious id in URL path', async () => {
    const res = await request(app)
      .post('/api/ingredients/' + encodeURIComponent(XSS_ID))
      .send({ id: XSS_ID, name: 'X', unit: 'Grams', active: true });
    expect(res.status).toBe(400);
  });

  it('POST /api/ingredients (bulk) — rejects array entry with malicious id', async () => {
    const res = await request(app).post('/api/ingredients').send([
      { id: XSS_ID, name: 'X', unit: 'Grams', active: true },
    ]);
    expect(res.status).toBe(400);
  });

  // Backslash and Unicode line-separator probes — `esc()` doesn't strip
  // either, so these would survive a future un-escaped renderer.
  it('POST /api/batches — rejects backslash-escaped quote', async () => {
    const res = await request(app).post('/api/batches').send({ ...baseBatch, id: "a\\';alert(1);//" });
    expect(res.status).toBe(400);
  });

  it('POST /api/batches — rejects U+2028 line separator', async () => {
    const res = await request(app).post('/api/batches').send({ ...baseBatch, id: "a alert(1)" });
    expect(res.status).toBe(400);
  });
});
