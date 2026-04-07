import express, { Request, Response } from 'express';
import { prisma } from '../lib/db';
import { errMsg } from '../lib/config';

const router = express.Router();

// GET all feedback (newest first)
router.get('/', async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.feedback.findMany({ orderBy: { id: 'desc' } });
    res.json(rows);
  } catch (e: unknown) {
    console.error('Feedback fetch error:', errMsg(e));
    res.status(500).json({ error: 'Could not fetch feedback' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  const { type, text, screen, user, timestamp, userAgent } = req.body;
  if (!text) return res.status(400).json({ error: 'Feedback text required' });

  try {
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
  } catch (e: unknown) {
    console.error('Feedback save error:', errMsg(e));
    res.status(500).json({ error: 'Could not save feedback' });
  }
});

// PATCH /api/feedback/:id — mark as processed/unprocessed
router.patch('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const { processed } = req.body;
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  if (typeof processed !== 'boolean') return res.status(400).json({ error: 'processed must be a boolean' });

  try {
    const updated = await prisma.feedback.update({
      where: { id },
      data: { processed },
    });
    res.json(updated);
  } catch (e: unknown) {
    console.error('Feedback patch error:', errMsg(e));
    res.status(500).json({ error: 'Could not update feedback' });
  }
});

export default router;
