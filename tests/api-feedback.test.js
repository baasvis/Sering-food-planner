const { describe, it } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

describe('POST /api/feedback', () => {
  it('rejects empty feedback', async () => {
    const app = require('../server');
    const res = await request(app).post('/api/feedback').send({});
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('text'));
  });

  it('rejects feedback text over 5000 chars', async () => {
    const app = require('../server');
    const res = await request(app).post('/api/feedback').send({ text: 'x'.repeat(5001) });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('5000'));
  });
});
