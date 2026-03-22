const { describe, it } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

describe('POST /api/guest-history', () => {
  it('rejects non-object body', async () => {
    const app = require('../server');
    const res = await request(app)
      .post('/api/guest-history')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify('bad'));
    assert.strictEqual(res.status, 400);
  });

  it('rejects invalid location key', async () => {
    const app = require('../server');
    const res = await request(app).post('/api/guest-history').send({ invalid_loc: { lunch: { '2026-03-23': 50 } } });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('location'));
  });

  it('rejects invalid meal key', async () => {
    const app = require('../server');
    const res = await request(app).post('/api/guest-history').send({ west: { brunch: { '2026-03-23': 50 } } });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('meal'));
  });
});

describe('POST /api/guests-next-weeks', () => {
  it('rejects non-object body', async () => {
    const app = require('../server');
    const res = await request(app)
      .post('/api/guests-next-weeks')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify('bad'));
    assert.strictEqual(res.status, 400);
  });

  it('rejects invalid monday key format', async () => {
    const app = require('../server');
    const res = await request(app).post('/api/guests-next-weeks').send({ 'not-a-date': {} });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('monday key'));
  });
});
