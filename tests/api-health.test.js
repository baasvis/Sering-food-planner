const { describe, it } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../server');

describe('GET /api/health', () => {
  it('returns status ok', async () => {
    const res = await request(app).get('/api/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
  });

  it('reports config status', async () => {
    const res = await request(app).get('/api/health');
    assert.strictEqual(typeof res.body.authConfigured, 'boolean');
  });
});
