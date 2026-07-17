/**
 * POST /api/orders/export — order → downloadable .xlsx.
 *
 * DB-free: routes/orders.ts imports no prisma, so mount it on a bare express
 * app (like ingredients-import-parse.test.ts) and assert on the response
 * headers + the xlsx bytes. Safe to run alongside other suites (no staging DB).
 */
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import XLSX from 'xlsx';
import ordersRouter from '../routes/orders';
import { AppError } from '../lib/config';

const request = require('supertest');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/orders', ordersRouter);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof AppError ? err.status : 500;
    res.status(status).json({ error: err.message });
  });
  return app;
}

const app = makeApp();

const ITEMS = [
  { name: 'Olive oil 5L', orderCode: 'H12345', quantity: 3, unitLabel: 'can', price: 24.5 },
  { name: 'Chickpeas 2.5kg', orderCode: 'H67890', quantity: 10, unitLabel: 'tin', price: 3.2 },
];

describe('POST /api/orders/export', () => {
  it('returns a valid .xlsx attachment with a header row, the items, and a total', async () => {
    const res = await request(app).post('/api/orders/export')
      .send({ items: ITEMS, title: 'Landjuweel 2026', location: 'ev-landjuweel-2026' })
      .buffer(true).parse((r: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain('order-landjuweel-2026-');
    expect(res.headers['content-disposition']).toMatch(/\.xlsx"$/);

    const buf = res.body as Buffer;
    expect(buf[0]).toBe(0x50); // 'P'
    expect(buf[1]).toBe(0x4b); // 'K' — xlsx is a zip

    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
    expect(rows[0]).toEqual(['Item', 'Order code', 'Quantity', 'Unit', 'Est. unit price (€)', 'Est. line total (€)']);
    expect(rows[1]).toEqual(['Olive oil 5L', 'H12345', 3, 'can', 24.5, 73.5]);       // 3 × 24.5
    expect(rows[2]).toEqual(['Chickpeas 2.5kg', 'H67890', 10, 'tin', 3.2, 32]);        // 10 × 3.2
    // Total row (after a blank spacer): 73.5 + 32 = 105.5
    const totalRow = rows.find(r => r[4] === 'Total');
    expect(totalRow && totalRow[5]).toBe(105.5);
  });

  it('coerces junk numbers and caps strings without throwing', async () => {
    const res = await request(app).post('/api/orders/export')
      .send({ items: [{ name: 42, orderCode: null, quantity: 'x', unitLabel: undefined, price: 'nope' }] });
    expect(res.status).toBe(200); // 42→"42", qty→0, price→0, no crash
  });

  it('400s on an empty or missing items array', async () => {
    expect((await request(app).post('/api/orders/export').send({ items: [] })).status).toBe(400);
    expect((await request(app).post('/api/orders/export').send({})).status).toBe(400);
  });
});
