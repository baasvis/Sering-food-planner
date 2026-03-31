import express, { Request, Response } from 'express';
import { prisma } from '../lib/db';
import { errMsg } from '../lib/config';

const router = express.Router();

// ── Standard Inventory ──

router.get('/standard-inventory', async (req: Request, res: Response) => {
  try {
    const location = (req.query.location as string) || 'west';
    const items = await prisma.standardInventory.findMany({ where: { location } });
    res.json(items);
  } catch (e: unknown) {
    console.error('standard-inventory read error:', errMsg(e));
    res.status(500).json({ error: errMsg(e) });
  }
});

router.post('/standard-inventory', async (req: Request, res: Response) => {
  const { location, items } = req.body;
  if (!location || !Array.isArray(items)) return res.status(400).json({ error: 'Expected { location, items }' });
  try {
    await prisma.$transaction([
      prisma.standardInventory.deleteMany({ where: { location } }),
      prisma.standardInventory.createMany({
        data: items.map((i: any) => ({ id: i.id, name: i.name, amount: i.amount, unit: i.unit, location })),
      }),
    ]);
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(500).json({ error: errMsg(e) });
  }
});

// ── Storage Config ──

router.get('/storage-config', async (_req: Request, res: Response) => {
  try {
    const row = await prisma.storageConfig.findUnique({ where: { id: 'default' } });
    res.json(row ? row.config : {});
  } catch (e: unknown) {
    console.error('storage-config read error:', errMsg(e));
    res.json({});
  }
});

router.post('/storage-config', async (req: Request, res: Response) => {
  const config = req.body;
  if (!config || typeof config !== 'object') return res.status(400).json({ error: 'Expected object' });
  try {
    await prisma.storageConfig.upsert({
      where: { id: 'default' },
      create: { id: 'default', config },
      update: { config },
    });
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(500).json({ error: errMsg(e) });
  }
});

// ── Prep Checklist ──

router.get('/prep-checklist', async (req: Request, res: Response) => {
  const { loc, date } = req.query as { loc?: string; date?: string };
  if (!loc || !date) return res.status(400).json({ error: 'loc and date required' });
  try {
    const entry = await prisma.prepChecklist.findUnique({
      where: { loc_date: { loc, date } },
    });
    res.json(entry ? entry.checked : []);
  } catch (e: unknown) {
    console.error('prep-checklist read error:', errMsg(e));
    res.status(500).json({ error: errMsg(e) });
  }
});

router.post('/prep-checklist', async (req: Request, res: Response) => {
  const { loc, date, checked } = req.body;
  if (!loc || !date) return res.status(400).json({ error: 'loc and date required' });
  try {
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
  } catch (e: unknown) {
    res.status(500).json({ error: errMsg(e) });
  }
});

// ── Activity Log ──

router.get('/log', async (_req: Request, res: Response) => {
  try {
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
  } catch (e: unknown) {
    console.error('log read error:', errMsg(e));
    res.status(500).json({ error: errMsg(e) });
  }
});

export default router;
