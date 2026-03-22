const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const db = require('../lib/db');

const VALID_GUESTS = {
  west: { Mon: { lunch: 30, dinner: 20 }, Tue: { lunch: 30, dinner: 20 }, Wed: { lunch: 30, dinner: 20 }, Thu: { lunch: 30, dinner: 20 }, Fri: { lunch: 30, dinner: 20 }, Sat: { lunch: 0, dinner: 0 }, Sun: { lunch: 0, dinner: 0 } },
  centraal: { Mon: { lunch: 20, dinner: 15 }, Tue: { lunch: 20, dinner: 15 }, Wed: { lunch: 20, dinner: 15 }, Thu: { lunch: 20, dinner: 15 }, Fri: { lunch: 20, dinner: 15 }, Sat: { lunch: 0, dinner: 0 }, Sun: { lunch: 0, dinner: 0 } },
};

const VALID_DISH = {
  id: 'd1', name: 'Test Soup', type: 'Soup', stock: 0, serving: 280,
  storage: 'Gastro', logistics: 'Sering West',
  services: [{ loc: 'west', date: '2026-03-23', meal: 'lunch' }],
};

describe('GET /api/data', () => {
  beforeEach(() => {
    mock.method(db, 'dbReadAll', async () => ({
      dishes: [VALID_DISH], guests: VALID_GUESTS, recipeIndex: [], caterings: [], transportItems: [],
    }));
  });

  it('returns planner data', async () => {
    const app = require('../server');
    const res = await request(app).get('/api/data');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.dishes));
    assert.strictEqual(res.body.dishes[0].name, 'Test Soup');
  });
});

describe('POST /api/data', () => {
  beforeEach(() => {
    mock.method(db, 'dbWriteAll', async () => {});
    mock.method(db, 'dbAppendLog', async () => {});
  });

  it('passes validation with valid data', async () => {
    const app = require('../server');
    const res = await request(app)
      .post('/api/data')
      .send({ dishes: [VALID_DISH], guests: VALID_GUESTS, caterings: [], transportItems: [] });
    // Valid data passes validation (not 400) — may get 500 if no DATABASE_URL
    assert.notStrictEqual(res.status, 400);
  });

  it('rejects dishes with missing fields', async () => {
    const app = require('../server');
    const res = await request(app)
      .post('/api/data')
      .send({ dishes: [{ id: 'd1', name: 'Bad Dish' }], guests: VALID_GUESTS });
    assert.strictEqual(res.status, 400);
  });

  it('rejects invalid guest structure', async () => {
    const app = require('../server');
    const res = await request(app)
      .post('/api/data')
      .send({ dishes: [], guests: { west: {} } });
    assert.strictEqual(res.status, 400);
  });

  it('rejects invalid catering', async () => {
    const app = require('../server');
    const res = await request(app)
      .post('/api/data')
      .send({ dishes: [], guests: VALID_GUESTS, caterings: [{ name: 'No ID' }] });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('Catering'));
  });

  it('passes validation with valid catering', async () => {
    const app = require('../server');
    const res = await request(app)
      .post('/api/data')
      .send({
        dishes: [], guests: VALID_GUESTS,
        caterings: [{ id: 'c1', name: 'Test Event', date: '2026-04-01', guestCount: 50, dishes: [] }],
      });
    // Valid data passes validation (not 400) — may get 500 if no DATABASE_URL
    assert.notStrictEqual(res.status, 400);
  });
});
