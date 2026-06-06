/**
 * TEST-4 — Supplier (Hanos) XLSX upload parsing.
 *
 * The only prior coverage (test/xlsx-api-smoke.test.ts) exercises the xlsx
 * LIBRARY round-trip with generic headers; it never touches the real
 * column-mapping in routes/ingredients-import.ts. This test feeds a small
 * in-memory XLSX built with the exact Hanos column headers through the ACTUAL
 * route handler (so a Hanos format drift or a parser regression fails CI).
 *
 * DB-free by design: the ingredients-import router imports no prisma, so we
 * mount it on a bare express() app and drive it with supertest. No staging-DB
 * access — safe to run alongside other suites.
 */
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import XLSX from 'xlsx';
import importRouter from '../routes/ingredients-import';
import { AppError } from '../lib/config';

const request = require('supertest');

// Mount ONLY the parser route, plus a minimal error handler that mirrors the
// app's AppError → status mapping (app.ts:188) so malformed-upload 400s surface.
function makeApp() {
  const app = express();
  app.use('/api/ingredients', importRouter);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof AppError ? err.status : 500;
    res.status(status).json({ error: err.message });
  });
  return app;
}

// Build a Hanos-shaped sheet (header row + data rows) into an XLSX buffer.
// Column names match exactly what routes/ingredients-import.ts looks up.
function buildXlsx(rows: (string | number | null)[][], sheetName = 'prices'): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const HEADERS = [
  'title', 'artikelnummer', 'stukprijs', 'hoeveelheid', 'categorie',
  // six month columns (match /^[A-Z][a-z]{2}-\d{2}$/) — used for recentOrders + priceHistory
  'Aug-25', 'Sep-25', 'Oct-25', 'Nov-25', 'Dec-25', 'Jan-26',
  // nutrition columns (per 100g) — only a subset, to prove partial nutrition works
  'Energie (kJ)', 'Energie (Kcal)', 'Eiwitten (gram)', 'Vet (gram)', 'Zout (gram)',
];

describe('Supplier XLSX parse (routes/ingredients-import.ts)', () => {
  const app = makeApp();

  it('extracts the expected ingredient rows from a Hanos-shaped XLSX', async () => {
    const buf = buildXlsx([
      HEADERS,
      // Tomatoes: priced, 5kg unit, orders in 3 of the 6 months.
      ['Gepelde tomaten', 12345, 2.49, 'Doos 5 kilo', 'Groente & Fruit',
        0, 2, 0, 1, 0, 3,
        95, 22, 1.2, 0.3, 0.02],
      // Olive oil: 1 liter unit, string-formatted price cell in one month.
      ['Olijfolie extra vergine', 67890, 8.95, 'Fles 1 liter', 'Oliën & Vetten',
        '', '', 1, '', 2, '',
        3389, 824, 0, 91.6, 0],
    ]);

    const res = await request(app)
      .post('/api/ingredients/upload-supplier')
      .attach('file', buf, { filename: 'hanos.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);

    const tom = res.body[0];
    expect(tom.title).toBe('Gepelde tomaten');
    expect(tom.orderCode).toBe('12345');            // coerced to string
    expect(tom.price).toBeCloseTo(2.49);
    expect(tom.orderUnit).toBe('Doos 5 kilo');
    expect(tom.category).toBe('Groente & Fruit');
    expect(tom.orderUnitSize).toBe(5000);           // 5 kilo → 5000 g (hanos-parser)
    expect(tom.recentOrders).toBeCloseTo(6);        // 2 + 1 + 3 across last-6 months
    // priceHistory only records non-empty/non-zero month cells.
    expect(tom.priceHistory).toEqual([
      { month: 'Sep-25', price: 2 },
      { month: 'Nov-25', price: 1 },
      { month: 'Jan-26', price: 3 },
    ]);
    expect(tom.nutrition).toEqual({
      energyKj: 95, energyKcal: 22, protein: 1.2, fat: 0.3, salt: 0.02,
    });

    const oil = res.body[1];
    expect(oil.title).toBe('Olijfolie extra vergine');
    expect(oil.orderCode).toBe('67890');
    expect(oil.orderUnitSize).toBe(1000);           // 1 liter → 1000
    expect(oil.recentOrders).toBeCloseTo(3);        // 1 + 2
    expect(oil.priceHistory).toEqual([
      { month: 'Oct-25', price: 1 },
      { month: 'Dec-25', price: 2 },
    ]);
  });

  it('skips rows without a title and returns [] for a header-only sheet', async () => {
    const headerOnly = buildXlsx([HEADERS]);
    const res1 = await request(app)
      .post('/api/ingredients/upload-supplier')
      .attach('file', headerOnly, { filename: 'empty.xlsx' });
    expect(res1.status).toBe(200);
    expect(res1.body).toEqual([]);

    // A data row missing the title column is filtered out.
    const withBlankRow = buildXlsx([
      HEADERS,
      ['', 999, 1.0, 'Stuk 1 stuk', 'Diversen', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ['Real product', 111, 3.5, 'Zak 500 gram', 'Diversen', 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ]);
    const res2 = await request(app)
      .post('/api/ingredients/upload-supplier')
      .attach('file', withBlankRow, { filename: 'mixed.xlsx' });
    expect(res2.status).toBe(200);
    expect(res2.body).toHaveLength(1);
    expect(res2.body[0].title).toBe('Real product');
    expect(res2.body[0].orderUnitSize).toBe(500);   // 500 gram → 500
  });

  it('falls back to the first sheet when there is no "prices" sheet', async () => {
    const buf = buildXlsx([
      HEADERS,
      ['Brood', 222, 1.2, 'Stuk 1 stuk', 'Brood', 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0],
    ], 'Sheet1');
    const res = await request(app)
      .post('/api/ingredients/upload-supplier')
      .attach('file', buf, { filename: 'firstsheet.xlsx' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe('Brood');
    expect(res.body[0].orderUnitSize).toBe(0);      // "stuk" → 0 g (count unit)
    expect(res.body[0].recentOrders).toBeCloseTo(5);
  });

  it('rejects a non-spreadsheet upload with 400', async () => {
    const res = await request(app)
      .post('/api/ingredients/upload-supplier')
      .attach('file', Buffer.from('not a spreadsheet'), { filename: 'note.txt', contentType: 'text/plain' });
    // multer's fileFilter rejects the extension/mime before the handler runs.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
