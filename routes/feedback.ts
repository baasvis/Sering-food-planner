import express, { Request, Response } from 'express';
import { prisma, withWriteLock } from '../lib/db';
import { asyncHandler } from '../lib/config';

const router = express.Router();

// GET all feedback (newest first)
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await prisma.feedback.findMany({ orderBy: { id: 'desc' } });
  res.json(rows);
}));

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const { type, text, screen, user, timestamp, userAgent } = req.body;
  if (!text) return res.status(400).json({ error: 'Feedback text required' });

  await prisma.feedback.create({
    data: {
      timestamp: timestamp || new Date().toISOString(),
      user: user || 'anonymous',
      type: type || 'general',
      screen: screen || '',
      text,
      userAgent: userAgent || '',
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
