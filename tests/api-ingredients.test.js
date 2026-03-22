const { describe, it } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

describe('POST /api/ingredients (bulk save)', () => {
  it('rejects non-array body', async () => {
    const app = require('../server');
    const res = await request(app).post('/api/ingredients').send({ bad: true });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('array'));
  });

  it('rejects ingredient without id', async () => {
    const app = require('../server');
    const res = await request(app).post('/api/ingredients').send([{ name: 'Test' }]);
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('id'));
  });

  it('rejects ingredient without name', async () => {
    const app = require('../server');
    const res = await request(app).post('/api/ingredients').send([{ id: 'i1' }]);
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('name'));
  });

  it('rejects too many ingredients', async () => {
    const app = require('../server');
    const items = Array.from({ length: 2001 }, (_, i) => ({ id: `i${i}`, name: `Ing ${i}` }));
    const res = await request(app).post('/api/ingredients').send(items);
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('2000'));
  });
});

describe('POST /api/ingredients/:id', () => {
  it('rejects ingredient without name', async () => {
    const app = require('../server');
    const res = await request(app).post('/api/ingredients/test-id').send({ id: 'test-id' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('name'));
  });
});

describe('POST /api/ingredients/upload-supplier', () => {
  it('rejects request without file', async () => {
    const app = require('../server');
    const res = await request(app).post('/api/ingredients/upload-supplier');
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('file'));
  });
});
