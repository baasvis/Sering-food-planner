import express, { Request, Response } from 'express';
import { prisma, dbAppendLog, withWriteLock } from '../lib/db';
import { asyncHandler, AppError } from '../lib/config';

const router = express.Router();

// ── Standard Inventory ──

interface StandardInventoryItem {
  id: string;
  name: string;
  amount: number;
  unit: string;
}

router.get('/standard-inventory', asyncHandler(async (req: Request, res: Response) => {
  const location = (req.query.location as string) || 'west';
  const items = await prisma.standardInventory.findMany({ where: { location } });
  res.json(items);
}));

router.post('/standard-inventory', asyncHandler(async (req: Request, res: Response) => {
  const { location, items } = req.body;
  if (!location || !Array.isArray(items)) return res.status(400).json({ error: 'Expected { location, items }' });
  // Scope-by-location delete-all/create-all. withWriteLock keeps two staff
  // editing the same location's standard inventory from clobbering each other.
  await withWriteLock(async () => {
    await prisma.$transaction([
      prisma.standardInventory.deleteMany({ where: { location } }),
      prisma.standardInventory.createMany({
        data: items.map((i: StandardInventoryItem) => ({ id: i.id, name: i.name, amount: i.amount, unit: i.unit, location })),
      }),
    ]);
  });
  res.json({ ok: true });
}));

// ── Storage Config ──

router.get('/storage-config', asyncHandler(async (_req: Request, res: Response) => {
  const row = await prisma.storageConfig.findUnique({ where: { id: 'default' } });
  res.json(row ? row.config : {});
}));

router.post('/storage-config', asyncHandler(async (req: Request, res: Response) => {
  const config = req.body;
  if (!config || typeof config !== 'object') return res.status(400).json({ error: 'Expected object' });
  await withWriteLock(async () => {
    await prisma.storageConfig.upsert({
      where: { id: 'default' },
      create: { id: 'default', config },
      update: { config },
    });
  });
  res.json({ ok: true });
}));

// ── Kitchen Equipment (single-row config; powers Fix My Menu's pot allocation) ──

router.get('/kitchen-equipment', asyncHandler(async (_req: Request, res: Response) => {
  const row = await prisma.kitchenEquipment.findUnique({ where: { id: 'default' } });
  res.json(row ? {
    pots: row.pots,
    gasBurners: row.gasBurners,
    inductionBurners: row.inductionBurners,
    bigBurnerThreshold: row.bigBurnerThreshold,
  } : {
    pots: [],
    gasBurners: 0,
    inductionBurners: 0,
    bigBurnerThreshold: 80,
  });
}));

router.post('/kitchen-equipment', asyncHandler(async (req: Request, res: Response) => {
  const { pots, gasBurners, inductionBurners, bigBurnerThreshold } = req.body || {};
  if (!Array.isArray(pots) || pots.some(p => typeof p !== 'number' || p <= 0 || p > 1000)) {
    return res.status(400).json({ error: 'pots must be an array of positive numbers (≤ 1000 L each)' });
  }
  if (typeof gasBurners !== 'number' || gasBurners < 0 || gasBurners > 100) {
    return res.status(400).json({ error: 'gasBurners must be 0–100' });
  }
  if (typeof inductionBurners !== 'number' || inductionBurners < 0 || inductionBurners > 100) {
    return res.status(400).json({ error: 'inductionBurners must be 0–100' });
  }
  const threshold = typeof bigBurnerThreshold === 'number' ? bigBurnerThreshold : 80;
  if (threshold < 1 || threshold > 1000) {
    return res.status(400).json({ error: 'bigBurnerThreshold must be 1–1000 L' });
  }
  await prisma.kitchenEquipment.upsert({
    where: { id: 'default' },
    create: { id: 'default', pots, gasBurners, inductionBurners, bigBurnerThreshold: threshold },
    update: { pots, gasBurners, inductionBurners, bigBurnerThreshold: threshold },
  });
  res.json({ ok: true });
}));

// ── Prep Checklist ──

router.get('/prep-checklist', asyncHandler(async (req: Request, res: Response) => {
  const { loc, date } = req.query as { loc?: string; date?: string };
  if (!loc || !date) return res.status(400).json({ error: 'loc and date required' });
  const entry = await prisma.prepChecklist.findUnique({
    where: { loc_date: { loc, date } },
  });
  res.json(entry ? entry.checked : []);
}));

router.post('/prep-checklist', asyncHandler(async (req: Request, res: Response) => {
  const { loc, date, checked } = req.body;
  if (!loc || !date) return res.status(400).json({ error: 'loc and date required' });
  await withWriteLock(async () => {
    await prisma.prepChecklist.upsert({
      where: { loc_date: { loc, date } },
      create: { loc, date, checked: Array.isArray(checked) ? checked : [] },
      update: { checked: Array.isArray(checked) ? checked : [], updatedAt: new Date() },
    });
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 3);
    await prisma.prepChecklist.deleteMany({
      where: { updatedAt: { lt: cutoff } },
    });
  });
  res.json({ ok: true });
}));

// ── Cooked Food Inventory completions ──
// Persists "the lunch/dinner inventory was completed at this time" so every
// device can show a freshness counter. We piggyback on the Log table — no
// schema change — and key by `loc|window` in details. Server reads the most
// recent entry per key.

const INV_LOCS = new Set(['west', 'centraal']);
const INV_WINDOWS = new Set(['lunch', 'dinner']);

router.post('/inventory-completions', asyncHandler(async (req: Request, res: Response) => {
  const { loc, window } = req.body || {};
  if (!INV_LOCS.has(loc)) throw new AppError(400, 'loc must be "west" or "centraal"');
  if (!INV_WINDOWS.has(window)) throw new AppError(400, 'window must be "lunch" or "dinner"');
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  const completedAt = new Date().toISOString();
  await dbAppendLog(user.email, user.name, 'inventory-complete', `${loc}|${window}`);
  res.json({ ok: true, loc, window, completedAt });
}));

router.get('/inventory-completions/latest', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await prisma.log.findMany({
    where: { action: 'inventory-complete' },
    orderBy: { id: 'desc' },
    take: 200,
  });
  const result: Record<string, Record<string, string | null>> = {
    west: { lunch: null, dinner: null },
    centraal: { lunch: null, dinner: null },
  };
  for (const r of rows) {
    const [loc, window] = (r.details || '').split('|');
    if (!INV_LOCS.has(loc) || !INV_WINDOWS.has(window)) continue;
    if (result[loc][window] === null) result[loc][window] = r.timestamp;
  }
  res.json(result);
}));

// ── Activity Log ──

router.get('/log', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await prisma.log.findMany({
    orderBy: { id: 'desc' },
    take: 50,
  });
  res.json(rows.map(r => ({
    timestamp: r.timestamp,
    email: r.email,
    name: r.name,
    action: r.action,
    details: r.details,
  })));
}));

export default router;
