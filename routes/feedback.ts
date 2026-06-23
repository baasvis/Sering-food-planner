import express, { Request, Response } from 'express';
import { prisma, withWriteLock } from '../lib/db';
import { asyncHandler } from '../lib/config';

const router = express.Router();

// GET all feedback (newest first)
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await prisma.feedback.findMany({ orderBy: { id: 'desc' } });
  res.json(rows);
}));

const VALID_SOURCES = new Set(['quick', 'assistant']);
const VALID_SEVERITIES = new Set(['', 'low', 'medium', 'high']);

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const { type, text, screen, user, timestamp, userAgent, title, severity, source, details } = req.body;
  if (!text) return res.status(400).json({ error: 'Feedback text required' });

  await prisma.feedback.create({
    data: {
      timestamp: timestamp || new Date().toISOString(),
      user: user || 'anonymous',
      type: type || 'general',
      screen: screen || '',
      text,
      userAgent: userAgent || '',
      // Structured fields from the AI intake assistant (legacy quick form omits
      // them → defaults). Validate the enums; the JSON details ride through as-is.
      title: typeof title === 'string' ? title.slice(0, 120) : '',
      severity: typeof severity === 'string' && VALID_SEVERITIES.has(severity) ? severity : '',
      source: typeof source === 'string' && VALID_SOURCES.has(source) ? source : 'quick',
      details: details && typeof details === 'object'
        ? (details as import('@prisma/client').Prisma.InputJsonValue)
        : undefined,
    },
  });
  res.json({ ok: true });
}));

// PATCH /api/feedback/:id — mark as processed/unprocessed
router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  const { processed } = req.body;
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  if (typeof processed !== 'boolean') return res.status(400).json({ error: 'processed must be a boolean' });

  const updated = await withWriteLock(async () => prisma.feedback.update({
    where: { id },
    data: { processed },
  }));
  res.json(updated);
}));

export default router;
