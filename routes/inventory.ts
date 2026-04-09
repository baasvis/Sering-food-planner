import express, { Request, Response } from 'express';
import { prisma } from '../lib/db';
import { asyncHandler } from '../lib/config';

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
  await prisma.$transaction([
    prisma.standardInventory.deleteMany({ where: { location } }),
    prisma.standardInventory.createMany({
      data: items.map((i: StandardInventoryItem) => ({ id: i.id, name: i.name, amount: i.amount, unit: i.unit, location })),
    }),
  ]);
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
  await prisma.storageConfig.upsert({
    where: { id: 'default' },
    create: { id: 'default', config },
    update: { config },
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
  res.json({ ok: true });
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
