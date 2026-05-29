import express, { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma, dbAppendLog, withWriteLock } from '../lib/db';
import { asyncHandler, AppError } from '../lib/config';
import { broadcast } from './events';

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
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  broadcast(user.email, 'patch', { user: user.name, storageConfig: config });
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
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  broadcast(user.email, 'patch', {
    user: user.name,
    kitchenEquipment: { pots, gasBurners, inductionBurners, bigBurnerThreshold: threshold },
  });
  res.json({ ok: true });
}));

// ── Cook Rhythm (single-row config; editable Fix My Menu rules) ──
// config = { days: { Mon: { soup, main, chefs }, ... } }. Stored as a single
// JSON column. The frontend merges these over its built-in defaults, so an
// empty/missing row falls back to the default rhythm.

const COOK_RHYTHM_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

router.get('/cook-rhythm', asyncHandler(async (_req: Request, res: Response) => {
  const row = await prisma.cookRhythm.findUnique({ where: { id: 'default' } });
  res.json(row && row.config ? row.config : { days: {} });
}));

router.post('/cook-rhythm', asyncHandler(async (req: Request, res: Response) => {
  const inDays = (req.body && req.body.days) as Record<string, unknown> | undefined;
  if (!inDays || typeof inDays !== 'object' || Array.isArray(inDays)) {
    return res.status(400).json({ error: 'Expected { days: { Mon: {soup,main,chefs}, ... } }' });
  }
  const days: Record<string, { soup: number; main: number; chefs: number }> = {};
  for (const day of COOK_RHYTHM_DAYS) {
    const d = inDays[day] as Record<string, unknown> | undefined;
    if (!d || typeof d !== 'object') continue;
    const fields: Record<string, number> = {};
    for (const key of ['soup', 'main', 'chefs'] as const) {
      const v = Number(d[key]);
      if (!Number.isFinite(v) || v < 0 || v > 50) {
        return res.status(400).json({ error: `${day}.${key} must be a number 0–50` });
      }
      fields[key] = Math.round(v);
    }
    days[day] = { soup: fields.soup, main: fields.main, chefs: fields.chefs };
  }
  const config = { days };
  await withWriteLock(async () => {
    await prisma.cookRhythm.upsert({
      where: { id: 'default' },
      create: { id: 'default', config: config as unknown as Prisma.InputJsonValue },
      update: { config: config as unknown as Prisma.InputJsonValue },
    });
  });
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'cook-rhythm-update', 'Updated Fix My Menu cook rhythm');
  broadcast(user.email, 'patch', { user: user.name, cookRhythm: config });
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
  const checkedArr: string[] = Array.isArray(checked) ? checked : [];
  await withWriteLock(async () => {
    await prisma.prepChecklist.upsert({
      where: { loc_date: { loc, date } },
      create: { loc, date, checked: checkedArr },
      update: { checked: checkedArr, updatedAt: new Date() },
    });
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 3);
    await prisma.prepChecklist.deleteMany({
      where: { updatedAt: { lt: cutoff } },
    });
  });
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  broadcast(user.email, 'patch', {
    user: user.name,
    prepChecklist: { loc, date, checked: checkedArr },
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
  broadcast(user.email, 'patch', {
    user: user.name,
    inventoryCompletion: { loc, window, completedAt },
  });
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
