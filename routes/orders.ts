// ─────────────────────────────────────────────────────────────────────────────
// ORDERS — export an order as a downloadable Excel (.xlsx) file.
//
// The alternative to "add to the Hanos cart": the order screen POSTs the same
// item list here and gets back a spreadsheet the user can download and handle
// however they like (email a supplier, hand it to on-site crew, keep a record).
// Especially useful at event locations, where you may not want to dump a
// festival's worth of items into West's live Hanos cart.
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response } from 'express';
import XLSX from 'xlsx';
import { asyncHandler, AppError } from '../lib/config';

const router = express.Router();

interface OrderExportItem {
  name?: unknown;
  orderCode?: unknown;
  quantity?: unknown;
  unitLabel?: unknown;
  price?: unknown;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v : String(v ?? '')).slice(0, max);
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (n: number): number | string => (n ? Math.round(n * 100) / 100 : '');

// Excel sheet names: max 31 chars, none of []:*?/\ .
function sheetName(title: string): string {
  const clean = title.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31);
  return clean || 'Order';
}

// POST /api/orders/export — { items, title?, location? } → .xlsx download.
router.post('/export', asyncHandler(async (req: Request, res: Response) => {
  const { items, title, location } = req.body as { items?: unknown; title?: unknown; location?: unknown };
  if (!Array.isArray(items) || items.length === 0) throw new AppError(400, 'items array required');
  if (items.length > 5000) throw new AppError(400, 'too many items');

  const header = ['Item', 'Order code', 'Quantity', 'Unit', 'Est. unit price (€)', 'Est. line total (€)'];
  const rows: (string | number)[][] = [header];
  let total = 0;
  for (const raw of items as OrderExportItem[]) {
    const qty = num(raw.quantity);
    const price = num(raw.price);
    // Round each line to cents and sum the ROUNDED lines, so the Total foots
    // exactly against the visible line totals (summing the raw products could
    // disagree by a cent).
    const line = Math.round(qty * price * 100) / 100;
    total += line;
    rows.push([str(raw.name, 200), str(raw.orderCode, 100), qty, str(raw.unitLabel, 50), money(price), money(line)]);
  }
  rows.push([]);
  rows.push(['', '', '', '', 'Total', Math.round(total * 100) / 100]);

  const ws = XLSX.utils.aoa_to_sheet(rows);
  (ws as { '!cols'?: unknown })['!cols'] = [{ wch: 38 }, { wch: 16 }, { wch: 10 }, { wch: 12 }, { wch: 18 }, { wch: 18 }];
  (ws as { '!freeze'?: unknown })['!freeze'] = { xSplit: 0, ySplit: 1 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName(str(title, 40) || str(location, 40) || 'Order'));

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const date = new Date().toISOString().slice(0, 10);
  const fnameBase = (str(title, 40) || str(location, 40) || 'order').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'order';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="order-${fnameBase}-${date}.xlsx"`);
  res.send(buf);
}));

export default router;
