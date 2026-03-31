// ─────────────────────────────────────────────────────────────────────────────
// FINANCE — Revenue data from Tebi POS
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response } from 'express';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { prisma } from '../lib/db';
import type { Prisma } from '@prisma/client';

const router = express.Router();

// In-memory sync state
let syncProcess: ChildProcess | null = null;
let syncTimeout: ReturnType<typeof setTimeout> | null = null;
let syncOutput = '';
let lastSyncAt: string | null = null;
let lastSyncError: string | null = null;

function killSync(reason: string) {
  if (syncTimeout) { clearTimeout(syncTimeout); syncTimeout = null; }
  if (syncProcess) {
    console.log(`[finance] Killing sync: ${reason}`);
    lastSyncError = reason + (syncOutput ? '. Output: ' + syncOutput.slice(-300) : '');
    try { syncProcess.kill('SIGKILL'); } catch (_e) { /* already dead */ }
    syncProcess = null;
  }
}

router.get('/revenue', async (req: Request, res: Response) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params required (YYYY-MM-DD)' });
  }

  const rows = await prisma.dailyRevenue.findMany({
    where: { date: { gte: start as string, lte: end as string } },
    orderBy: [{ date: 'asc' }, { location: 'asc' }],
  });

  res.json(rows);
});

router.get('/products', async (req: Request, res: Response) => {
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
});

router.post('/sync', (req: Request, res: Response) => {
  if (syncProcess) {
    return res.status(409).json({ error: 'Sync already in progress' });
  }

  if (!process.env.TEBI_EMAIL || !process.env.TEBI_PASSWORD) {
    return res.status(500).json({ error: 'TEBI_EMAIL and TEBI_PASSWORD not configured' });
  }

  const { startDate, endDate } = req.body;

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const defaultDate = yesterday.toISOString().slice(0, 10);

  const start = startDate || defaultDate;
  const end = endDate || start;

  const workerPath = path.join(__dirname, '..', 'scripts', 'tebi-sync-worker.js');
  const args = [workerPath, start, end];

  console.log(`[finance] Starting sync: ${start} → ${end}`);
  lastSyncError = null;
  syncOutput = '';

  syncProcess = spawn('node', args, {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  syncProcess.stdout!.on('data', (data: Buffer) => {
    syncOutput += data.toString();
    data.toString().trim().split('\n').forEach((line: string) => {
      if (line) console.log(`[finance] ${line}`);
    });
  });

  syncProcess.stderr!.on('data', (data: Buffer) => {
    syncOutput += data.toString();
    console.error(`[finance] ${data.toString().trim()}`);
  });

  syncProcess.on('close', (code: number | null) => {
    console.log(`[finance] Sync finished with code ${code}`);
    if (syncTimeout) { clearTimeout(syncTimeout); syncTimeout = null; }
    if (code === 0) {
      lastSyncAt = new Date().toISOString();
      lastSyncError = null;
    } else if (!lastSyncError) {
      lastSyncError = `Sync failed (exit code ${code}). ${syncOutput.slice(-500)}`;
    }
    syncProcess = null;
  });

  syncProcess.on('error', (err: Error) => {
    console.error(`[finance] Sync process error: ${err.message}`);
    killSync('Sync process error: ' + err.message);
  });

  syncTimeout = setTimeout(() => killSync('Sync timed out after 2 minutes'), 2 * 60 * 1000);

  res.json({ status: 'syncing', startDate: start, endDate: end });
});

router.post('/sync-cancel', (_req: Request, res: Response) => {
  killSync('Sync cancelled by user');
  res.json({ status: 'cancelled' });
});

router.get('/sync-status', (_req: Request, res: Response) => {
  res.json({
    syncing: !!syncProcess,
    lastSyncAt,
    lastSyncError,
    tebiConfigured: !!(process.env.TEBI_EMAIL && process.env.TEBI_PASSWORD),
  });
});

export default router;
