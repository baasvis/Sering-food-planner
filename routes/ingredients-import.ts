import express, { Request, Response } from 'express';
import multer from 'multer';
import XLSX from 'xlsx';
import { errMsg, AppError } from '../lib/config';
import { parseHanosQuantityGrams } from '../lib/hanos-parser';

const router = express.Router();

// File filter: accept only XLSX (Hanos supplier export) and CSV (legacy import).
// 20 MB cap covers a Hanos export of ~10k ingredients with full price history.
// Without the filter, multer accepted anything and only XLSX.read failed at
// parse time, but the buffer was already in memory.
const ACCEPTED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel',                                          // .xls (legacy)
  'text/csv',
  'application/csv',
  'application/octet-stream', // some browsers send this for .xlsx — accepted with extension check below
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  // multer types are loose (project ships only `declare module 'multer'`),
  // so we hand-type the fileFilter signature here.
  fileFilter: (_req: Request, file: { mimetype: string; originalname: string }, cb: (err: Error | null, accept?: boolean) => void) => {
    const ok = ACCEPTED_MIME.has(file.mimetype) || /\.(xlsx|xls|csv)$/i.test(file.originalname);
    if (!ok) return cb(new Error('Only .xlsx, .xls, and .csv files are accepted'));
    cb(null, true);
  },
});

// Upload and parse Hanos XLSX — returns parsed products for review.
// Sync handler: thrown errors bubble to the Express error middleware natively
// (no asyncHandler needed). AppError(400) for user-input errors, so the user
// sees a 400 (not 500) for malformed uploads.
router.post('/upload-supplier', upload.single('file'), (req: Request, res: Response) => {
  const file = (req as any).file;
  if (!file) throw new AppError(400, 'No file uploaded');

  let wb;
  try {
    wb = XLSX.read(file.buffer, { type: 'buffer' });
  } catch (e: unknown) {
    console.error('XLSX parse error:', errMsg(e));
    throw new AppError(400, 'Failed to parse XLSX file');
  }
  const ws = wb.Sheets['prices'] || wb.Sheets[wb.SheetNames[0]];
  const data: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
  if (data.length < 2) return res.json([]);
  const headers = data[0] as string[];

  const col = (name: string) => headers.indexOf(name);
  const titleIdx = col('title');
  const codeIdx = col('artikelnummer');
  const priceIdx = col('stukprijs');
  const qtyIdx = col('hoeveelheid');
  const catIdx = col('categorie');

  // Find month columns for recent order detection
  const monthCols = headers.map((h, i) => ({ name: h, idx: i }))
    .filter(c => /^[A-Z][a-z]{2}-\d{2}$/.test(c.name));
  const last6 = monthCols.slice(-6);

  // Nutrition column indices
  const nutIdx: Record<string, number> = {
    energyKj: col('Energie (kJ)'), energyKcal: col('Energie (Kcal)'),
    protein: col('Eiwitten (gram)'), carbs: col('Koolhydraten (gram)'),
    sugar: col('- waarvan suiker (gram)'), fat: col('Vet (gram)'),
    saturatedFat: col('- waarvan verzadigd (gram)'),
    fiber: col('Vezels (gram)'), salt: col('Zout (gram)'),
  };

  const products = data.slice(1).filter(r => r[titleIdx]).map(r => {
    const recentOrders = last6.reduce((sum, mc) => sum + (parseFloat(r[mc.idx]) || 0), 0);
    const priceHistory: Array<{ month: string; price: number }> = [];
    monthCols.forEach(mc => {
      const raw = r[mc.idx];
      if (raw == null || raw === '' || raw === 0) return;
      const val = typeof raw === 'string' ? parseFloat(raw.replace(/[€\s,]/g, '').replace(',', '.')) : parseFloat(raw);
      if (!isNaN(val) && val > 0) priceHistory.push({ month: mc.name.trim(), price: Math.round(val * 100) / 100 });
    });
    const nutrition: Record<string, number> = {};
    Object.entries(nutIdx).forEach(([key, idx]) => {
      if (idx >= 0 && r[idx] != null && r[idx] !== '') nutrition[key] = parseFloat(r[idx]) || 0;
    });

    return {
      title: r[titleIdx] || '',
      orderCode: String(r[codeIdx] || ''),
      price: r[priceIdx] != null ? parseFloat(r[priceIdx]) : null,
      orderUnit: r[qtyIdx] || '',
      category: r[catIdx] || '',
      orderUnitSize: parseHanosQuantityGrams(r[qtyIdx] || ''),
      recentOrders: Math.round(recentOrders * 10) / 10,
      priceHistory,
      nutrition: Object.keys(nutrition).length ? nutrition : null,
    };
  });

  res.json(products);
});

// Note: a one-shot `POST /api/ingredients/migrate` route lived here for the
// Sheets→Postgres migration in March 2026. It was deleted in May 2026 once
// the migration was complete (see audit T19a follow-up — its
// deleteMany+createMany pattern would silently wipe recipe-ingredient FKs
// if re-run). The CLI counterpart `scripts/migrate-ingredients.js` was
// removed at the same time.

export default router;
