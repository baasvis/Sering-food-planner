// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — AI insights & telemetry management (protected by requireAuth)
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response } from 'express';
import { prisma } from '../lib/db';
import { asyncHandler } from '../lib/config';
import { generateInsights, aggregateTelemetry } from '../lib/ai-analyzer';
import type { InsightStatus } from '../shared/types';

const router = express.Router();

// ── POST /api/admin/analyze — trigger AI analysis ──

let analysisRunning = false;

router.post('/analyze', asyncHandler(async (_req: Request, res: Response) => {
  if (analysisRunning) {
    res.status(409).json({ error: 'Analysis already running' });
    return;
  }
  analysisRunning = true;
  try {
    const count = await generateInsights();
    res.json({ ok: true, insightsGenerated: count });
  } finally {
    analysisRunning = false;
  }
}));

// ── GET /api/admin/insights — list insights with filters ──

router.get('/insights', asyncHandler(async (req: Request, res: Response) => {
  const { status, category, severity } = req.query;
  const where: Record<string, string> = {};
  if (typeof status === 'string') where.status = status;
  if (typeof category === 'string') where.category = category;
  if (typeof severity === 'string') where.severity = severity;

  const insights = await prisma.aiInsight.findMany({
    where,
    orderBy: { timestamp: 'desc' },
    take: 100,
  });
  res.json(insights);
}));

// ── PATCH /api/admin/insights/:id — update insight status ──

const VALID_STATUSES: InsightStatus[] = ['new', 'reviewed', 'resolved', 'dismissed'];

router.patch('/insights/:id', asyncHandler(async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  const { status } = req.body as { status?: string };
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  if (!status || !VALID_STATUSES.includes(status as InsightStatus)) {
    res.status(400).json({ error: 'Invalid status' });
    return;
  }

  const data: { status: string; resolvedAt?: Date } = { status };
  if (status === 'resolved') data.resolvedAt = new Date();

  const updated = await prisma.aiInsight.update({ where: { id }, data });
  res.json(updated);
}));

// ── GET /api/admin/telemetry/summary — aggregated telemetry ──

router.get('/telemetry/summary', asyncHandler(async (req: Request, res: Response) => {
  const hours = parseInt(req.query.hours as string, 10) || 24;
  const summary = await aggregateTelemetry(hours);
  res.json(summary);
}));

export default router;
