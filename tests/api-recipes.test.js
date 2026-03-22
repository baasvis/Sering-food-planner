const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const db = require('../lib/db');

describe('POST /api/recipe-index', () => {
  it('rejects recipe without id', async () => {
    const app = require('../server');
    const res = await request(app).post('/api/recipe-index').send({ name: 'No ID Recipe' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('id'));
  });

  it('rejects recipe without name', async () => {
    const app = require('../server');
    const res = await request(app).post('/api/recipe-index').send({ id: 'r1' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('name'));
  });
});

describe('GET /api/recipe', () => {
  it('requires sheetId param', async () => {
    const app = require('../server');
    const res = await request(app).get('/api/recipe');
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('sheetId'));
  });

  it('rejects invalid sheetId format', async () => {
    const app = require('../server');
    const res = await request(app).get('/api/recipe?sheetId=../../../etc/passwd');
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('Invalid'));
  });
});
