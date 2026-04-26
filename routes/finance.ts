// ─────────────────────────────────────────────────────────────────────────────
// FINANCE — Revenue data from Tebi POS
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response } from 'express';
import { prisma } from '../lib/db';
import { asyncHandler } from '../lib/config';
import { runTebiSync, cancelSync, getStatus, isSyncing } from '../lib/tebi-sync';
import type { Prisma } from '@prisma/client';

const router = express.Router();

router.get('/revenue', asyncHandler(async (req: Request, res: Response) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params required (YYYY-MM-DD)' });
  }

  const rows = await prisma.dailyRevenue.findMany({
    where: { date: { gte: start as string, lte: end as string } },
    orderBy: [{ date: 'asc' }, { location: 'asc' }],
  });

  res.json(rows);
}));

router.get('/products', asyncHandler(async (req: Request, res: Response) => {
  const { start, end, location, meal, groupBy } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params required (YYYY-MM-DD)' });
  }

  const where: Prisma.ProductRevenueWhereInput = { date: { gte: start as string, lte: end as string } };
  if (location) where.location = location as string;
  if (meal) where.meal = meal as string;

  const rows = await prisma.productRevenue.findMany({
    where,
    orderBy: [{ grossRevenue: 'desc' }],
  });

  if (groupBy === 'category') {
    interface CategoryAgg { productCategory: string; quantity: number; grossRevenue: number; netRevenue: number; products: number }
    const categories: Record<string, CategoryAgg> = {};
    for (const row of rows) {
      const cat = row.productCategory || 'Other';
      if (!categories[cat]) {
        categories[cat] = { productCategory: cat, quantity: 0, grossRevenue: 0, netRevenue: 0, products: 0 };
      }
      categories[cat].quantity += row.quantity;
      categories[cat].grossRevenue += row.grossRevenue;
      categories[cat].netRevenue += row.netRevenue;
      categories[cat].products += 1;
    }
    const result = Object.values(categories)
      .map((c) => ({
        ...c,
        grossRevenue: Math.round(c.grossRevenue * 100) / 100,
        netRevenue: Math.round(c.netRevenue * 100) / 100,
      }))
      .sort((a, b) => b.grossRevenue - a.grossRevenue);
    return res.json(result);
  }

  res.json(rows);
}));

router.post('/sync', (req: Request, res: Response) => {
  if (isSyncing()) {
    return res.status(409).json({ error: 'Sync already in progress' });
  }

  const { startDate, endDate } = req.body;

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const defaultDate = yesterday.toISOString().slice(0, 10);

  const start = startDate || defaultDate;
  const end = endDate || start;

  const result = runTebiSync({ start, end, source: 'manual' });
  if (!result.ok) {
    // Propagate the refusal reason. The shared helper rejects up front for
    // missing credentials or an in-flight sync; treat the latter as a 409,
    // everything else as 500 so the user can tell them apart.
    const status = result.error === 'Sync already in progress' ? 409 : 500;
    return res.status(status).json({ error: result.error });
  }

  res.json({ status: 'syncing', startDate: start, endDate: end });
});

router.post('/sync-cancel', (_req: Request, res: Response) => {
  const cancelled = cancelSync('Sync cancelled by user');
  res.json({ status: cancelled ? 'cancelled' : 'not-running' });
});

router.get('/sync-status', asyncHandler(async (_req: Request, res: Response) => {
  res.json(await getStatus());
}));

export default router;
