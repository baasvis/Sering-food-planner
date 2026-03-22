const { describe, it } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

describe('POST /api/standard-inventory', () => {
  it('rejects missing location or items', async () => {
    const app = require('../server');
    const res = await request(app).post('/api/standard-inventory').send({ items: [] });
    assert.strictEqual(res.status, 400);
  });

  it('rejects invalid location', async () => {
    const app = require('../server');
    const res = await request(app).post('/api/standard-inventory').send({ location: 'north', items: [] });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('west or centraal'));
  });

  it('rejects items without required fields', async () => {
    const app = require('../server');
    const res = await request(app).post('/api/standard-inventory').send({ location: 'west', items: [{ name: 'No ID' }] });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('id'));
  });

  it('rejects too many items', async () => {
    const app = require('../server');
    const items = Array.from({ length: 501 }, (_, i) => ({ id: `i${i}`, name: `Item ${i}`, amount: 1, unit: 'kg' }));
    const res = await request(app).post('/api/standard-inventory').send({ location: 'west', items });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('500'));
  });
});

describe('GET /api/prep-checklist', () => {
  it('requires loc and date params', async () => {
    const app = require('../server');
    const res = await request(app).get('/api/prep-checklist');
    assert.strictEqual(res.status, 400);
  });
});

describe('POST /api/prep-checklist', () => {
  it('requires loc and date', async () => {
    const app = require('../server');
    const res = await request(app).post('/api/prep-checklist').send({ checked: [] });
    assert.strictEqual(res.status, 400);
  });

  it('rejects invalid location', async () => {
    const app = require('../server');
    const res = await request(app).post('/api/prep-checklist').send({ loc: 'north', date: '2026-03-23', checked: [] });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('west or centraal'));
  });

  it('rejects invalid date format', async () => {
    const app = require('../server');
    const res = await request(app).post('/api/prep-checklist').send({ loc: 'west', date: '23-03-2026', checked: [] });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('YYYY-MM-DD'));
  });
});
